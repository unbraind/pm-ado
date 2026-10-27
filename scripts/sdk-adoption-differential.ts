/** Compare built packages over disposable copies of public tracker snapshots. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { PmClient, readHistoryEntries } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import type * as Package from "../index.ts";
import type { AdoWorkItem } from "../index.ts";
import { localValues } from "../sync.ts";

const run = promisify(execFile);
const repo = resolve(import.meta.dirname, "..");

/** Fingerprint authoritative inputs while allowing disposable derived caches. */
async function fingerprint(root: string, readonly = false): Promise<string> {
  const hash = createHash("sha256");
  /** Visit only the supplied bounded snapshot, never filesystem-wide paths. */
  async function visit(dir: string): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (["extensions", "runtime", "search", "locks", "transactions", "checkpoints"].includes(entry.name)) continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        hash.update(file.slice(root.length)).update(await readFile(file));
        if (readonly) await chmod(file, 0o444);
      }
    }
  }
  await visit(root);
  return hash.digest("hex");
}

/** Run both affected APIs using an independently built package in a git-free process. */
async function worker(build: string, workspace: string, org: string): Promise<void> {
  const candidate = createRequire(join(build, "package.json"))(join(build, "dist/index.js")) as typeof Package;
  const pmRoot = join(workspace, ".agents/pm");
  const pm = new PmClient({ cwd: workspace, pmRoot, author: "differential-runner" });
  process.chdir(workspace);
  process.env.PM_AUTHOR = "differential-runner";
  process.env.ADO_ORG_URL = org;
  process.env.ADO_PROJECT = "PublicFixture";
  process.env.ADO_TOKEN = "synthetic-token";
  delete process.env.ADO_STATUS_MAP;
  delete process.env.ADO_EXPORT_STATE_MAP;
  const harness = await createExtensionTestHarness(candidate.default, { name: "pm-ado", capabilities: ["commands", "schema", "preflight"] });
  assert.deepEqual(harness.activation.failed, []);
  const items = (await pm.listAllComplete()).items;
  const linked = items.find((item) => item.ado_id === 1)!;
  const applyWorkspace = `${workspace}-apply`;
  await cp(workspace, applyWorkspace, { recursive: true });
  const before = await fingerprint(pmRoot, true);
  const outputs: unknown[] = [];
  for (const mode of ["import", "export", "sync"]) {
    const result = await harness.runCommand({ command: `ado ${mode}`, pmRoot, options: { dryRun: true, limit: 12 } });
    assert.equal((result.result as { ok: boolean }).ok, true, JSON.stringify(result.result));
    outputs.push(result.result);
  }
  const config = { orgUrl: org, project: "PublicFixture", token: "synthetic-token" };
  const client = new candidate.AdoClient(config, async (method, url, body, headers) => {
    const response = await fetch(url, { method, body, headers });
    return { status: response.status, body: await response.text() };
  });
  outputs.push(await new candidate.AdoResolutionService(pmRoot, "differential-runner", pm, client, config).plan(linked.id));
  assert.equal(await fingerprint(pmRoot), before, "read-only commands changed authoritative files");
  const applyRoot = join(applyWorkspace, ".agents/pm");
  process.chdir(applyWorkspace);
  const priorHistory = await readHistoryEntries(join(applyRoot, "history", `${linked.id}.jsonl`), linked.id);
  const applied = await harness.runCommand({ command: "ado import", pmRoot: applyRoot, options: { limit: 12 } });
  assert.equal((applied.result as { ok: boolean }).ok, true, JSON.stringify(applied.result));
  outputs.push(applied.result);
  const appliedPm = new PmClient({ cwd: applyWorkspace, pmRoot: applyRoot, author: "differential-runner" });
  const final = (await appliedPm.get(linked.id, { depth: "full" })).item;
  delete final.updated_at;
  // Per-key witnessed revisions are new internal recovery coordinates, not synced values.
  if (typeof final.ado_sync_base === "string") {
    const canonical = JSON.parse(final.ado_sync_base) as Record<string, unknown>;
    delete canonical.ado_base_fields; delete canonical.ado_agreed_revisions; final.ado_sync_base = JSON.stringify(canonical);
  }
  outputs.push(final);
  const history = await readHistoryEntries(join(applyRoot, "history", `${linked.id}.jsonl`), linked.id);
  const last = history.at(-1)!;
  const delta = history.slice(priorHistory.length);
  assert.ok(delta.every((entry) => entry.op === last.op && entry.author === last.author));
  // Agreement now has its own guarded, final event. Compare the same net patch,
  // retaining its event count separately as an intentional audit-history difference.
  const net = new Map(delta.flatMap((entry) => entry.patch).filter((entry) => entry.path !== "/metadata/updated_at" && entry.path !== "/metadata/ado_sync_intent").map((entry) => [entry.path, entry]));
  outputs.push({ history_before_length: priorHistory.length, op: last.op, author: last.author,
    patch: [...net.values()].map((entry) => {
      if (entry.path === "/metadata/ado_sync_base" && "value" in entry) {
        const value = JSON.parse(String(entry.value)) as Record<string, unknown>;
        delete value.ado_base_fields; delete value.ado_agreed_revisions; return { ...entry, value: JSON.stringify(value) };
      }
      return entry;
    }).sort((a, b) => a.path.localeCompare(b.path)) });
  assert.equal(await fingerprint(pmRoot), before, "mutation must use a separate writable copy");
  process.stdout.write(JSON.stringify({ items: items.length, outputs, history_message: last.message, history_new_events: delta.length }));
}

/** Prepare identical inputs once, then compare origin/main and the candidate byte-for-byte. */
async function compare(baseline: string, trackers: string[]): Promise<void> {
  assert.ok(trackers.length >= 2, "provide at least two public fleet tracker snapshots");
  const scratch = await mkdtemp(join(tmpdir(), "ado-sdk-differential-"));
  const remote = new Map<number, AdoWorkItem>();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as { ids?: number[] } : {};
    res.setHeader("Content-Type", "application/json");
    if (req.url!.includes("/wiql?")) res.end(JSON.stringify({ workItems: [...remote.keys()].map((id) => ({ id })) }));
    else if (req.url!.includes("/workitemsbatch?")) res.end(JSON.stringify({ value: body.ids!.map((id) => remote.get(id)) }));
    else res.end(JSON.stringify(remote.get(Number(req.url!.split("?")[0].split("/").at(-1)))));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const org = `http://127.0.0.1:${address.port}/organization`;
  try {
    let total = 0;
    for (const [index, tracker] of trackers.entries()) {
      const seed = join(scratch, `seed-${index}`);
      const pmRoot = join(seed, ".agents/pm");
      await mkdir(dirname(pmRoot), { recursive: true });
      await cp(resolve(tracker), pmRoot, { recursive: true });
      const installed = join(pmRoot, "extensions/pm-ado");
      await mkdir(installed, { recursive: true });
      await cp(join(repo, "dist"), join(installed, "dist"), { recursive: true });
      await cp(join(repo, "manifest.json"), join(installed, "manifest.json"));
      const pm = new PmClient({ cwd: seed, pmRoot, author: "differential-runner" });
      const items = (await pm.listAllComplete()).items;
      assert.ok(items.length > 0);
      const item = items.find((item) => item.status === "open" && item.assignee === undefined)!;
      assert.ok(item, "public corpus needs an open item");
      await pm.update(item.id, { force: true, field: ["ado_id=1", "ado_rev=1", "ado_project=PublicFixture", `ado_org_url=${org}`] });
      const fields = localValues(item);
      remote.clear();
      remote.set(1, { id: 1, rev: 1, relations: [], fields: {
        "System.Title": fields.title, "System.Description": fields.description, "System.State": "New",
        "System.WorkItemType": "Task", "Microsoft.VSTS.Common.Priority": fields.priority,
        "System.Tags": (fields.tags as string[]).join("; "), "System.AssignedTo": fields.assignee,
        "System.AreaPath": fields.ado_area_path, "System.IterationPath": fields.ado_iteration_path,
      } });
      const results: string[] = [];
      for (const [label, build] of [["before", baseline], ["after", repo]]) {
        const workspace = join(scratch, `${index}-${label}`);
        await cp(seed, workspace, { recursive: true });
        const { stdout } = await run(process.execPath, [resolve(import.meta.filename), "--worker", resolve(build), workspace, org],
          { env: { ...process.env, GIT_CEILING_DIRECTORIES: scratch, PATH: scratch }, maxBuffer: 16 * 1024 * 1024 });
        results.push(stdout);
      }
      const before = JSON.parse(results[0]) as Record<string, unknown>;
      const after = JSON.parse(results[1]) as Record<string, unknown>;
      assert.equal(before.history_message, "Azure DevOps revision 1");
      assert.match(String(after.history_message), /^bulk-item-transaction ado-sync-/u);
      assert.equal(before.history_new_events, 1);
      assert.equal(after.history_new_events, 3);
      delete before.history_new_events; delete after.history_new_events;
      delete before.history_message;
      delete after.history_message;
      const plan = (after.outputs as Record<string, unknown>[])[3];
      assert.equal(plan.normalization, "pm-ado/fields/1");
      delete plan.normalization; // Explicit version-2 canonical-coordinate marker; other plan fields stay exact.
      assert.deepEqual(after, before, `public corpus ${index + 1} differs`);
      total += items.length;
      console.log(`Public corpus ${index + 1}: ${items.length} items; import/export/sync dry-run and resolution plan identical after removing the documented canonical-coordinate marker; authoritative files unchanged; writable-copy import receipts/values/net history patches identical; candidate prepares its local intent and publishes agreement in separate guarded events.`);
    }
    console.log(`PASS: ${trackers.length} public corpora, ${total} real items, ${trackers.length * 7} differential comparisons; intentional history differences: SDK transaction markers, path ordering, three guarded events instead of one, and internal per-key revision/presence coordinates; synced base values and net patch identical; mutation timestamps normalized.`);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    // Undo read-only fixture permissions before portable cleanup.
    await rm(scratch, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args[0] === "--worker") await worker(args[1], args[2], args[3]);
else await compare(resolve(args[0]), args.slice(1));
