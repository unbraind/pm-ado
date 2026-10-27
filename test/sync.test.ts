/** Real host commands against a local Azure REST subset and disposable SDK trackers. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, fork } from "node:child_process";
import { chmodSync, cpSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import type * as Package from "../index.ts";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import * as runtimeSdk from "@unbrained/pm-cli/sdk";
import { PmClient, createExtensionCommandSdk, runWithActiveExtensions, resolveRuntimeStatusRegistry, readSettings } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { type AdoWorkItem, type AdoRelation, type JsonPatchOperation } from "../index.ts";
import { buildWiql, localValues, remoteValues, IMPORT_STATE_MAP, runSyncCommand, readLocalAgreement } from "../sync.ts";

import { SyncOutbox, isProtocolTag, type OutboxState, type SyncBoundary, type SyncObserver } from "../sync-outbox.ts";

const run = promisify(execFile);
const repo = resolve(import.meta.dirname, "..");
const cli = join(repo, "node_modules/@unbrained/pm-cli/dist/cli.js");

/** Build a full work item with optional field/revision overrides. */
function workItem(id = 1, fields: Record<string, unknown> = {}, rev = 1): AdoWorkItem {
  return { id, rev, relations: [], fields: { "System.Title": `Remote ${id}`, "System.Description": "Details", "System.State": "New",
    "System.WorkItemType": "Task", "Microsoft.VSTS.Common.Priority": 2, "System.Tags": "blue; green",
    "System.AssignedTo": { uniqueName: "fixture@example.invalid", displayName: "Fixture" },
    "System.AreaPath": "Project\\Area", "System.IterationPath": "Project\\Sprint", ...fields } };
}

/** Exact contract subset: revision assertions precede every atomic patch application. */
async function fixture(t: test.TestContext, initial: AdoWorkItem[] = [workItem()]) {
  const items = new Map(initial.map((item) => [item.id, structuredClone(item)]));
  const requests: { method: string; path: string; body: unknown }[] = [];
  let failStatus = 0;
  let race = false;
  let omit = false;
  let writeStatus = 0;
  let patchStatus = 0;
  let afterPatchStatus = 200;
  const effects: (number | "network-before" | "network-after" | "server-after" | "malformed")[] = [];
  let vanish = false;
  let omitRelations = false;
  let afterPatch: ((item: AdoWorkItem) => Promise<void>) | undefined;
  let afterBatch: (() => Promise<void>) | undefined;
  let afterCreate: (() => Promise<void>) | undefined;
  const revisions = new Map<string, AdoWorkItem>();
  const responses = new Map<string, unknown>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fixture.invalid");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> & JsonPatchOperation[] : undefined;
    requests.push({ method: req.method!, path: req.url!, body });
    for (const item of items.values()) revisions.set(`${item.id}:${item.rev}`, structuredClone(item));
    assert.equal(url.searchParams.get("api-version"), "7.1");
    assert.equal(req.headers.authorization, `Basic ${Buffer.from(`:${env.ADO_TOKEN}`).toString("base64")}`);
    res.setHeader("Content-Type", "application/json");
    /** Send the service response once. */
    const send = (status: number, value: unknown) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    if (responses.has(url.pathname.split("/").at(-1)!)) { send(200, responses.get(url.pathname.split("/").at(-1)!)); return; }
    if (patchStatus && req.method === "PATCH") { send(patchStatus, { message: "Write refused", typeKey: "RuleValidationException", errorCode: 0, eventId: 0 }); return; }
    if (writeStatus && (req.method === "PATCH" || url.pathname.includes("/workitems/"))) { send(writeStatus, { message: "Write refused", typeKey: "RuleValidationException", errorCode: 0, eventId: 0 }); return; }
    if (failStatus) { send(failStatus, { message: "Synthetic failure", typeKey: "VssServiceException", errorCode: 0, eventId: 0 }); return; }
    if (url.pathname.endsWith("/wiql")) {
      assert.equal(req.method, "POST");
      assert.equal(typeof body!.query, "string");
      const marker = String(body!.query).match(/\[System.Tags\] CONTAINS '([^']+)'/u)?.[1];
      const found = [...items.keys()].filter((id) => marker === undefined || String(items.get(id)!.fields["System.Tags"]).split(";").some((tag) => tag.trim() === marker));
      send(200, { queryType: "flat", queryResultType: "workItem", workItems: found.slice(0, Number(url.searchParams.get("$top") ?? items.size)).map((id) => ({ id, url: `${org}/_apis/wit/workItems/${id}` })) }); return;
    }
    if (url.pathname.endsWith("/workitemsbatch")) {
      assert.equal(req.method, "POST");
      if (body!.fields !== undefined) assert.deepEqual(body!.fields, ["System.Rev"]);
      else assert.equal(body!.$expand, "relations");
      assert.equal(body!.errorPolicy, "omit");
      assert.ok((body!.ids as number[]).length <= 200);
      await afterBatch?.();
      send(200, { count: items.size, value: omit ? [] : (body!.ids as number[]).flatMap((id) => items.has(id) ? [items.get(id)] : []) }); return;
    }
    const revision = url.pathname.match(/workitems\/(\d+)\/revisions\/(\d+)$/u);
    if (revision) { send(200, revisions.get(`${revision[1]}:${revision[2]}`)); return; }
    const effect = req.method === "PATCH" || url.pathname.includes("/workitems/$") ? effects.shift() : undefined;
    if (typeof effect === "number") { send(effect, { message: "Synthetic outcome" }); return; }
    if (effect === "network-before") { req.socket.destroy(); return; }
    const tail = decodeURIComponent(url.pathname.split("/").at(-1)!);
    if (req.method === "GET") { send(200, items.get(Number(tail))); return; }
    assert.equal(req.headers["content-type"], "application/json-patch+json");
    assert.equal(url.searchParams.get("$expand"), "relations");
    const patch = body as JsonPatchOperation[];
    if (req.method === "POST") {
      assert.ok(tail.startsWith("$"));
      assert.ok(patch.every((op) => op.op === "add"));
      const id = Math.max(0, ...items.keys()) + 1;
      const fields = Object.fromEntries(patch.map((op) => [op.path.slice("/fields/".length), op.value]));
      const item = workItem(id, { ...fields, "System.WorkItemType": tail.slice(1) });
      items.set(id, item); revisions.set(`${id}:${item.rev}`, structuredClone(item));
      await afterCreate?.();
      if (effect === "network-after") { req.socket.destroy(); return; }
      if (effect === "server-after") { send(503, { message: "Response unavailable after acceptance" }); return; }
      if (effect === "malformed") { res.statusCode = 201; res.end("not JSON"); return; }
      send(200, omitRelations ? { ...item, relations: undefined } : item); return;
    }
    assert.equal(req.method, "PATCH");
    const current = items.get(Number(tail))!;
    if (race) { current.rev++; current.fields["System.Title"] = "Concurrent writer"; revisions.set(`${current.id}:${current.rev}`, structuredClone(current)); race = false; }
    if (vanish || patch[0]?.op !== "test" || patch[0].path !== "/rev" || patch[0].value !== current.rev) {
      if (vanish) { items.delete(Number(tail)); vanish = false; }
      send(412, { $id: "1", innerException: null, message: "The current revision of the work item does not match the expected revision.",
        typeName: "Microsoft.TeamFoundation.WorkItemTracking.Server.WorkItemRevisionMismatchException, Microsoft.TeamFoundation.WorkItemTracking.Server",
        typeKey: "WorkItemRevisionMismatchException", errorCode: 0, eventId: 3200 }); return;
    }
    const next = structuredClone(current);
    const relations = [...next.relations!];
    for (const op of patch.slice(1)) {
      if (op.path === "/relations/-") relations.push(op.value as AdoRelation);
      else if (op.op === "remove") relations.splice(Number(op.path.split("/").at(-1)), 1);
      else {
        if (op.op === "replace") assert.ok(Object.hasOwn(next.fields, op.path.slice("/fields/".length)));
        next.fields[op.path.slice("/fields/".length)] = op.value;
      }
    }
    next.relations = relations;
    next.rev++;
    items.set(next.id, next);
    revisions.set(`${next.id}:${next.rev}`, structuredClone(next));
    await afterPatch?.(next);
    if (effect === "network-after") { req.socket.destroy(); return; }
    if (effect === "server-after") { send(503, { message: "Response unavailable after acceptance" }); return; }
    if (effect === "malformed") { res.statusCode = 200; res.end("not JSON"); return; }
    send(afterPatchStatus, omitRelations ? { ...next, relations: undefined } : next);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const org = `http://127.0.0.1:${address.port}/organization`;
  const root = mkdtempSync(join(tmpdir(), "ado-command-"));
  t.after(async () => { await new Promise<void>((done) => server.close(() => done())); rmSync(root, { recursive: true, force: true }); });
  const pmRoot = join(root, ".agents/pm");
  const pm = new PmClient({ cwd: root, pmRoot, author: "fixture-agent" });
  await pm.run("init", { prefix: "fixture" });
  mkdirSync(join(pmRoot, "extensions"), { recursive: true });
  const installed = join(pmRoot, "extensions/pm-ado");
  mkdirSync(installed);
  cpSync(join(repo, "dist"), join(installed, "dist"), { recursive: true });
  mkdirSync(join(root, "node_modules/@unbrained"), { recursive: true });
  symlinkSync(join(repo, "node_modules/@unbrained/pm-cli"), join(root, "node_modules/@unbrained/pm-cli"), "junction");
  writeFileSync(join(installed, "manifest.json"), readFileSync(join(repo, "manifest.json")));
  const env: NodeJS.ProcessEnv = { ...process.env, PM_AUTHOR: "fixture-agent", PM_NO_UPDATE_CHECK: "1", ADO_ORG_URL: org,
    ADO_PROJECT: "Project", ADO_TOKEN: "synthetic-token" };
  delete env.ADO_STATUS_MAP;
  delete env.ADO_EXPORT_STATE_MAP;
  delete env.ADO_WORK_ITEM_TYPE;
  const harness = await createExtensionTestHarness(extension, { name: "pm-ado", capabilities: ["commands", "schema", "preflight"] });
  assert.deepEqual(harness.activation.failed, []);
  /** Execute through real registration with the real host-created SDK client. */
  const command = async (mode: string, options: Record<string, unknown> = {}, global: { author?: string } = {}) => {
    const before = { ...process.env };
    const cwd = process.cwd();
    process.chdir(root);
    process.env = { ...env };
    try {
      const result = await harness.runCommand({ command: `ado ${mode}`, pmRoot: options.withoutSdk ? undefined : pmRoot, options, global });
      return result.result as { ok: boolean; code?: string; exit_code?: number; error?: string; plans: { action: string; import_fields: string[]; export_fields: string[]; ado_id: number | null; linked_fields?: string[] }[]; conflicts: { stored_rev: number; remote_rev: number; fields: Record<string, unknown> }[]; diagnostics: unknown[] };
    } finally { process.env = before; process.chdir(cwd); }
  };
  /** Invoke the actual CLI parser, renderer and exit handling in a child process. */
  const host = async (args: string[], overrides: Record<string, string> = {}) => {
    try { const result = await run(process.execPath, [cli, "--pm-path", pmRoot, ...args], { cwd: root, env: { ...env, ...overrides }, maxBuffer: 8 * 1024 * 1024 }); return { ...result, code: 0 }; }
    catch (error) { const result = error as { stdout: string; stderr: string; code: number }; return result; }
  };
  /** Apply custom registered fields through the real SDK in the tracker workspace. */
  const setFields = async (id: string, fields: Record<string, string | number>, unset: string[] = []) => {
    const cwd = process.cwd();
    process.chdir(root);
    try { return await pm.update(id, { field: Object.entries(fields).map(([key, value]) => `${key}=${value}`), unset }); }
    finally { process.chdir(cwd); }
  };
  /** Exercise the command with native SDK activation and a boundary observer. */
  const observed = async (mode: "import" | "export" | "sync", observer: SyncObserver, options: Record<string, unknown> = {}, anchors?: readonly string[]) => {
    const before = { ...process.env }; const cwd = process.cwd();
    process.chdir(root); process.env = { ...env };
    try {
      return await runWithActiveExtensions({ cwd: root, path: pmRoot }, () => runSyncCommand({ command: `ado ${mode}`, args: [], options,
        global: {}, pm_root: pmRoot, sdk: createExtensionCommandSdk(pmRoot, pm) }, mode, observer, anchors));
    } finally { process.env = before; process.chdir(cwd); }
  };
  return { pm, pmRoot, root, org, items, requests, command, observed, host, env, setFields,
    afterCreate: (hook: () => Promise<void>) => { afterCreate = hook; },
    afterBatch: (hook: () => Promise<void>) => { afterBatch = hook; },
    afterPatch: (hook: (item: AdoWorkItem) => Promise<void>) => { afterPatch = hook; },
    response: (endpoint: string, value: unknown) => { responses.set(endpoint, value); },
    effect: (outcome: (typeof effects)[number]) => { effects.push(outcome); },
    failPatch: (status: number) => { patchStatus = status; },
    afterPatchStatus: (status: number) => { afterPatchStatus = status; },
    failWrite: (status: number) => { writeStatus = status; },
    vanish: () => { vanish = true; },
    omitRelations: () => { omitRelations = true; },
    disconnect: () => new Promise<void>((done) => server.close(() => done())),
    race: () => { race = true; }, fail: (status: number) => { failStatus = status; }, omit: () => { omit = true; } };
}

/** Snapshot authoritative tracker files and history, excluding installed code and derived caches. */
function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  /** Traverse the bounded disposable tracker only. */
  function visit(dir: string, prefix: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ["runtime", "extensions", "locks", "transactions", "search", "checkpoints"].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) visit(path, `${name}/`);
      else result[name] = readFileSync(path, "utf8");
    }
  }
  visit(root, "");
  return result;
}

/** Get a single fully projected row from the disposable tracker. */
async function row(pm: PmClient) { return (await pm.listAllComplete()).items[0]!; }

test("first import, idempotent re-import and host JSON/TOON output", async (t) => {
  const f = await fixture(t);
  const result = await f.command("import", { areaPath: "Project\\Area", iterationPath: "Project\\Sprint", type: "Task" });
  assert.equal(result.ok, true, JSON.stringify(result));
  const item = await row(f.pm);
  assert.equal(item.ado_rev, 1);
  assert.equal(item.title, "Remote 1");
  assert.equal(item.assignee, "fixture@example.invalid");
  assert.deepEqual(item.tags, ["blue", "green"]);
  assert.equal(item.ado_area_path, "Project\\Area");
  const before = snapshot(f.pmRoot);
  assert.equal((await f.command("import")).ok, true);
  assert.deepEqual(snapshot(f.pmRoot), before);
  const json = await f.host(["ado", "import", "--limit", "1", "--json"]);
  assert.equal(json.code, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).ok, true);
  const toon = await f.host(["ado", "sync", "--dry-run", "--output-format", "toon"]);
  assert.equal(toon.code, 0, toon.stderr);
  assert.match(toon.stdout, /dry_run: true/u);
  assert.ok(f.requests[0]!.body && JSON.stringify(f.requests[0]!.body).includes("System.AreaPath"));
});

test("export creates an unlinked item and updates with the stored revision", async (t) => {
  const f = await fixture(t, []);
  const { item } = await f.pm.create({ title: "Local create", type: "Task", tags: "local" });
  const created = await f.command("export", { type: "User Story" });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(f.items.get(1)!.fields["System.WorkItemType"], "User Story");
  assert.equal((await row(f.pm)).ado_rev, 1);
  await f.pm.update(item.id, { title: "Local edited", assignee: "new@example.invalid" });
  const result = await f.command("export");
  assert.equal(result.ok, true, JSON.stringify(result));
  const patch = [...f.requests].reverse().find((request) => request.method === "PATCH")!.body as JsonPatchOperation[];
  assert.deepEqual(patch[0], { op: "test", path: "/rev", value: 1 });
  assert.equal(f.items.get(1)!.fields["System.Title"], "Local edited");
  assert.equal((await row(f.pm)).ado_rev, 2);
});

test("412 export conflict retains pm item and history byte-for-byte and has a real host failure code", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.command("import")).ok, true);
  const item = await row(f.pm);
  await f.pm.update(item.id, { title: "Local writer" });
  const before = snapshot(f.pmRoot);
  f.race();
  const result = await f.command("export");
  assert.equal(result.code, "ADO_CONFLICT", JSON.stringify(result));
  assert.equal(result.exit_code, 4);
  assert.equal(result.conflicts[0]!.stored_rev, 1);
  assert.equal(result.conflicts[0]!.remote_rev, 2);
  assert.ok(result.conflicts[0]!.fields.title);
  assert.deepEqual(snapshot(f.pmRoot), before);
  assert.equal(f.items.get(1)!.fields["System.Title"], "Concurrent writer");
  const real = await f.host(["ado", "export", "--json"]);
  assert.equal(real.code, 4, real.stderr + real.stdout);
  assert.match(real.stdout + real.stderr, /ADO_CONFLICT/u);
  assert.equal(JSON.parse(real.stdout).conflicts[0].remote_rev, 2);
  assert.deepEqual(snapshot(f.pmRoot), before);
});

test("sync reconciles remote-only and local-only fields; both-changed fields refuse the whole plan", async (t) => {
  const f = await fixture(t);
  await f.command("import");
  const item = await row(f.pm);
  f.items.get(1)!.fields["System.Title"] = "Remote only";
  f.items.get(1)!.rev++;
  assert.equal((await f.command("sync")).ok, true);
  assert.equal((await row(f.pm)).title, "Remote only");
  await f.pm.update(item.id, { description: "Local only" });
  f.items.get(1)!.fields["System.Tags"] = "remote-tag";
  f.items.get(1)!.rev++;
  const local = await f.command("sync");
  assert.equal(local.ok, true, JSON.stringify(local));
  assert.equal(f.items.get(1)!.fields["System.Description"], "Local only");
  await f.pm.update(item.id, { title: "Local both" });
  f.items.get(1)!.fields["System.Title"] = "Remote both";
  f.items.get(1)!.rev++;
  const before = snapshot(f.pmRoot);
  const requests = f.requests.length;
  const conflict = await f.command("sync");
  assert.equal(conflict.code, "ADO_CONFLICT");
  assert.deepEqual(conflict.conflicts[0]!.fields.title, { base: "Remote only", local: "Local both", remote: "Remote both" });
  assert.deepEqual(snapshot(f.pmRoot), before);
  assert.ok(f.requests.slice(requests).every((req) => req.method === "POST" && /wiql|workitemsbatch/u.test(req.path)));
});

test("dry-run import/export/sync write neither tracker files nor mutating HTTP requests", async (t) => {
  const f = await fixture(t);
  const before = snapshot(f.pmRoot);
  const preview = await f.command("import", { dryRun: true });
  assert.equal(preview.plans[0]!.action, "create_local");
  assert.deepEqual(snapshot(f.pmRoot), before);
  await f.command("import");
  await f.pm.update((await row(f.pm)).id, { title: "Pending local" });
  await f.pm.create({ title: "Unlinked pending", type: "Task" });
  const edited = snapshot(f.pmRoot);
  const start = f.requests.length;
  for (const mode of ["import", "export", "sync"]) {
    const plan = await f.command(mode, { "dry-run": true });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    assert.ok(plan.plans.some((entry) => entry.import_fields.length || entry.export_fields.length));
    assert.deepEqual(snapshot(f.pmRoot), edited);
  }
  assert.ok(f.requests.slice(start).every((req) => req.method === "POST" && /wiql|workitemsbatch/u.test(req.path)));
  assert.equal(f.items.size, 1);
  assert.equal(f.items.get(1)!.rev, 1);
});

test("relations round trip through real commands, with diagnostics for unknown links", async (t) => {
  const f = await fixture(t, [workItem(1), workItem(2)]);
  f.items.get(2)!.relations = [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: `${f.org}/_apis/wit/workItems/1` },
    { rel: "Unknown.Type", url: "https://fixture.invalid/opaque" }];
  f.items.get(1)!.relations = [{ rel: "System.LinkTypes.Hierarchy-Forward", url: `${f.org}/_apis/wit/workItems/2` }];
  const imported = await f.command("import");
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.equal(imported.diagnostics.length, 1);
  const items = (await f.pm.listAllComplete()).items;
  const parent = items.find((item) => item.ado_id === 1)!;
  const child = items.find((item) => item.ado_id === 2)!;
  assert.equal(child.parent, parent.id);
  await f.pm.update(parent.id, { dep: [`id=${child.id},kind=blocks`] });
  const result = await f.command("export");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(f.items.get(1)!.relations!.some((edge) => edge.rel === "System.LinkTypes.Dependency-Forward"));
  assert.ok(f.items.get(2)!.relations!.some((edge) => edge.rel === "Unknown.Type"));
  await f.command("import");
  const before = snapshot(f.pmRoot);
  await f.command("import");
  assert.deepEqual(snapshot(f.pmRoot), before);
});

test("preflight and invalid input fail before reads or calls; HTTP failures and omissions are nonzero", async (t) => {
  const f = await fixture(t);
  const missing = await f.host(["ado", "import", "--json"], { ADO_TOKEN: "" });
  assert.equal(missing.code, 2);
  assert.equal(f.requests.length, 0);
  for (const options of [{ limit: 0 }, { wiql: "SELECT 1", type: "Task" }, { areaPath: "" }]) {
    assert.equal((await f.command("import", options)).exit_code, 2);
    assert.equal(f.requests.length, 0);
  }
  f.fail(503);
  assert.equal((await f.command("import")).exit_code, 3);
  f.fail(0); f.omit();
  assert.equal((await f.command("import")).exit_code, 3);
});

test("query escaping and field projection defaults are explicit", () => {
  assert.match(buildWiql({ "area-path": "A'B" }, "P'Q"), /P''Q.*A''B/u);
  assert.equal(buildWiql({ wiql: "SELECT 1" }, "P"), "SELECT 1");
  assert.throws(() => remoteValues(workItem(1, { "System.State": "Unknown" }), IMPORT_STATE_MAP), /Unmapped/u);
  assert.throws(() => remoteValues(workItem(1, { "Microsoft.VSTS.Common.Priority": 7 }), IMPORT_STATE_MAP), /priority/u);
  assert.equal(remoteValues({ id: 1, rev: 1, fields: {} }, IMPORT_STATE_MAP).assignee, "");
  assert.equal(remoteValues(workItem(1, { "System.AssignedTo": { displayName: "Display" } }), IMPORT_STATE_MAP).assignee, "Display");
  assert.equal(remoteValues(workItem(1, { "System.AssignedTo": {} }), IMPORT_STATE_MAP).assignee, "");
  assert.equal(remoteValues(workItem(1, { "System.AssignedTo": "plain" }), IMPORT_STATE_MAP).assignee, "plain");
  assert.equal(localValues({ title: "T", status: "open", priority: 2, tags: [] } as unknown as Parameters<typeof localValues>[0]).description, "");
});

test("state-map configuration is validated before calls and custom state names round trip", async (t) => {
  const f = await fixture(t);
  for (const raw of ["{", "null", "[]", '"text"', '{"New":5}', '{"New":" "}']) {
    f.env.ADO_STATUS_MAP = raw;
    assert.equal((await f.command("import")).exit_code, 2, raw);
    assert.equal(f.requests.length, 0);
  }
  f.env.ADO_STATUS_MAP = '{"Review":"in_progress"}';
  f.env.ADO_EXPORT_STATE_MAP = '{"in_progress":"Review"}';
  f.items.get(1)!.fields["System.State"] = "Review";
  delete f.items.get(1)!.fields["System.WorkItemType"];
  assert.equal((await f.command("import")).ok, true);
  assert.equal((await row(f.pm)).status, "in_progress");
  const id = (await row(f.pm)).id;
  await f.pm.update(id, { status: "open" });
  assert.equal((await f.command("export")).ok, true);
  await f.pm.update(id, { status: "in_progress" });
  assert.equal((await f.command("export")).ok, true);
  assert.equal(f.items.get(1)!.fields["System.State"], "Review");
  await f.pm.update(id, { status: "canceled" });
  assert.equal((await f.command("export", { dryRun: true })).exit_code, 2);
});

test("legacy bases fail safely, equal legacy fields bootstrap, and malformed bases never write", async (t) => {
  const f = await fixture(t);
  await f.command("import");
  const item = await row(f.pm);
  await f.setFields(item.id, {}, ["ado_sync_base", "ado_org_url"]);
  const bootstrapped = await f.command("sync");
  assert.equal(bootstrapped.ok, true, JSON.stringify(bootstrapped));
  await f.setFields(item.id, {}, ["ado_sync_base"]);
  await f.pm.update(item.id, { title: "Legacy edit" });
  assert.equal((await f.command("sync")).code, "ADO_CONFLICT");
  const valid = String(item.ado_sync_base);
  const parsed = JSON.parse(valid) as Record<string, unknown>;
  for (const base of ["{", "null", "[]", JSON.stringify({ ...parsed, tags: [7] }), JSON.stringify({ ...parsed, title: 7 }), JSON.stringify({ ...parsed, tags: "wrong" })]) {
    await f.setFields(item.id, { ado_sync_base: base });
    const before = snapshot(f.pmRoot);
    const result = await f.command("sync");
    assert.equal(result.exit_code, 2, base);
    assert.equal(result.code, "ADO_USAGE", base);
    if (base === "{") {
      assert.match(result.error!, new RegExp(item.id, "u"));
      assert.match(result.error!, /ado_sync_base/u);
      const cliResult = await f.host(["ado", "sync", "--json"]);
      assert.equal(cliResult.code, 2);
      assert.equal(JSON.parse(cliResult.stdout).code, "ADO_USAGE");
    }
    assert.deepEqual(snapshot(f.pmRoot), before);
  }
});

test("invalid identity, scope and revision are refused before remote writes", async (t) => {
  const f = await fixture(t);
  await f.command("import");
  const item = await row(f.pm);
  for (const fields of [{ ado_org_url: "https://dev.azure.com/other" }, { ado_org_url: f.org, ado_project: "Other" },
    { ado_project: "Project", ado_id: 0 }, { ado_id: 1.5 }] as Record<string, string | number>[]) {
    await f.setFields(item.id, fields);
    assert.equal((await f.command("export")).exit_code, 2);
  }
  await f.setFields(item.id, { ado_id: 1 });
  const other = await f.pm.create({ title: "Duplicate identity", type: "Task" });
  await f.setFields(other.item.id, { ado_id: 1, ado_project: "Project" });
  assert.equal((await f.command("import")).exit_code, 2);
  await f.setFields(other.item.id, {}, ["ado_id"]);
  await f.pm.update(item.id, { title: "Pending edit" });
  for (const revision of [0, 1.5]) {
    await f.setFields(item.id, { ado_rev: revision });
    assert.equal((await f.command("export")).exit_code, 2);
  }
  await f.setFields(item.id, {}, ["ado_rev"]);
  assert.equal((await f.command("export")).exit_code, 2);
  assert.equal(f.requests.filter((req) => req.method === "PATCH").length, 0);
});

test("dry-run still needs credentials and a host SDK; transport failures remain nonzero", async (t) => {
  const f = await fixture(t);
  f.env.ADO_TOKEN = "";
  assert.equal((await f.command("import", { dryRun: true })).exit_code, 2);
  f.env.ADO_TOKEN = "synthetic-token";
  assert.equal((await f.command("import", { withoutSdk: true })).exit_code, 2);
  assert.equal(f.requests.length, 0);
  await f.disconnect();
  const failed = await f.command("import");
  assert.equal(failed.code, "ADO_REMOTE");
  assert.equal(JSON.stringify(failed).includes("synthetic-token"), false);
});

test("missing and malformed remote work items fail before importing documents", async (t) => {
  const f = await fixture(t);
  f.response("wiql", { workItems: [{ id: -1 }] });
  assert.equal((await f.command("import")).exit_code, 3);
  f.response("wiql", { workItems: [{ id: 1 }] });
  for (const remote of [{ ...workItem(), rev: 0 }, { ...workItem(), fields: null }, { ...workItem(), fields: "bad" }]) {
    f.response("workitemsbatch", { value: [remote] });
    assert.equal((await f.command("import")).exit_code, 3);
    assert.equal((await f.pm.listAllComplete()).items.length, 0);
  }
  const withoutRelations = workItem();
  delete withoutRelations.relations;
  f.response("workitemsbatch", { value: [withoutRelations] });
  assert.equal((await f.command("import")).ok, true);
});

test("batch and limit apply to real command reads; explicit WIQL is sent verbatim", async (t) => {
  const f = await fixture(t, Array.from({ length: 201 }, (_, index) => workItem(index + 1)));
  const result = await f.command("import", { limit: 201, dryRun: true, wiql: "SELECT [System.Id] FROM WorkItems" });
  assert.equal(result.ok, true);
  assert.equal(result.plans.length, 201);
  assert.equal(f.requests.filter((req) => req.path.includes("workitemsbatch")).length, 2);
  assert.deepEqual(f.requests[0]!.body, { query: "SELECT [System.Id] FROM WorkItems" });
  const limited = await f.host(["ado", "import", "--limit", "1", "--json"]);
  assert.equal(limited.code, 0, limited.stderr);
  assert.equal((await f.pm.listAllComplete()).items.length, 1);
});

test("new remote identities export their relations in the same invocation and default type is configurable", async (t) => {
  const f = await fixture(t, []);
  const parent = await f.pm.create({ title: "Parent", type: "Task" });
  await f.pm.create({ title: "Child", type: "Task", parent: parent.item.id });
  f.env.ADO_WORK_ITEM_TYPE = "User Story";
  assert.equal((await f.command("sync")).ok, true);
  assert.ok([...f.items.values()].some((item) => item.relations!.some((edge) => edge.rel === "System.LinkTypes.Hierarchy-Reverse")));
  assert.ok([...f.items.values()].every((item) => item.fields["System.WorkItemType"] === "User Story"));
  const before = snapshot(f.pmRoot);
  assert.equal((await f.command("sync")).ok, true);
  assert.deepEqual(snapshot(f.pmRoot), before);
  delete f.env.ADO_WORK_ITEM_TYPE;
  await f.pm.create({ title: "Default type", type: "Task" });
  const result = await f.command("export");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.items.get(3)!.fields["System.WorkItemType"], "Task");
});

test("remote relation additions import, local removals export, and remote removal refuses additive data loss", async (t) => {
  const f = await fixture(t, [workItem(1), workItem(2)]);
  await f.command("import");
  f.items.get(1)!.relations = [{ rel: "System.LinkTypes.Related", url: `${f.org}/_apis/wit/workItems/2` }];
  f.items.get(1)!.rev++;
  assert.equal((await f.command("sync", { limit: 1 })).ok, true);
  const a = (await f.pm.listAllComplete()).items.find((item) => item.ado_id === 1)!;
  assert.ok(a.dependencies!.length);
  f.items.get(1)!.relations = [];
  f.items.get(1)!.rev++;
  const before = snapshot(f.pmRoot);
  assert.equal((await f.command("sync", { limit: 1 })).code, "ADO_CONFLICT");
  assert.deepEqual(snapshot(f.pmRoot), before);
  assert.equal((await f.command("export", { dryRun: true })).code, "ADO_CONFLICT");
});

test("write failures and disappearing conflicts preserve the local item", async (t) => {
  const f = await fixture(t);
  await f.command("import");
  const item = await row(f.pm);
  await f.pm.update(item.id, { title: "Local pending" });
  const before = snapshot(f.pmRoot);
  f.failWrite(400);
  assert.equal((await f.command("export")).exit_code, 3);
  assert.deepEqual(snapshot(f.pmRoot), before);
  f.failWrite(0); f.vanish();
  const result = await f.command("export");
  assert.equal(result.code, "ADO_CONFLICT");
  assert.equal(result.conflicts[0]!.remote_rev, null);
  assert.deepEqual(result.conflicts[0]!.fields.title, { local: "Local pending", remote: null });
  assert.deepEqual(snapshot(f.pmRoot), before);
});

test("actual CLI import/export/sync apply changes and dry-run preserves authoritative files and server log", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.host(["ado", "import", "--json"])).code, 0);
  const item = await row(f.pm);
  await f.pm.update(item.id, { description: "CLI local edit" });
  assert.equal((await f.host(["ado", "export", "--json"])).code, 0);
  assert.equal(f.items.get(1)!.fields["System.Description"], "CLI local edit");
  f.items.get(1)!.fields["System.Title"] = "CLI remote edit";
  f.items.get(1)!.rev++;
  assert.equal((await f.host(["ado", "sync", "--json"])).code, 0);
  assert.equal((await row(f.pm)).title, "CLI remote edit");
  await f.pm.update(item.id, { title: "Pending CLI edit" });
  const before = snapshot(f.pmRoot);
  const start = f.requests.length;
  for (const mode of ["import", "export", "sync"]) {
    const result = await f.host(["ado", mode, "--dry-run", "--limit", "1", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).dry_run, true);
    assert.deepEqual(snapshot(f.pmRoot), before);
  }
  assert.ok(f.requests.slice(start).every((req) => /wiql|workitemsbatch/u.test(req.path)));
});

test("relation-only export removals use revision-checked JSON Patch", async (t) => {
  const f = await fixture(t, [workItem(1), workItem(2)]);
  f.items.get(1)!.relations = [{ rel: "System.LinkTypes.Related", url: `${f.org}/_apis/wit/workItems/2` }];
  f.items.get(2)!.relations = [{ rel: "System.LinkTypes.Related", url: `${f.org}/_apis/wit/workItems/1` }];
  await f.command("import");
  for (const item of (await f.pm.listAllComplete()).items) await f.pm.update(item.id, { clearDeps: true });
  assert.equal((await f.command("export")).ok, true);
  assert.ok([...f.items.values()].every((item) => item.relations!.length === 0));
  assert.ok(f.requests.some((req) => Array.isArray(req.body) && (req.body as JsonPatchOperation[]).some((op) => op.op === "remove")));
});

test("creation relation races retain identities across export retries and report revisions and fields", async (t) => {
  const f = await fixture(t, []);
  const a = await f.pm.create({ title: "Unlinked A", type: "Task" });
  await f.pm.create({ title: "Unlinked B", type: "Task", parent: a.item.id });
  f.race();
  const result = await f.command("export");
  assert.equal(result.code, "ADO_CONFLICT", JSON.stringify(result));
  assert.equal(result.conflicts[0]!.stored_rev, 1);
  assert.equal(result.conflicts[0]!.remote_rev, 2);
  assert.ok(result.conflicts[0]!.fields.title);
  assert.ok(result.conflicts[0]!.fields.relations);
  await assertRetainedCreates(f, result);
});

test("Azure can omit empty relation collections in successful create responses and diagnostic reads", async (t) => {
  const f = await fixture(t, []);
  await f.pm.create({ title: "No relations", type: "Task" });
  f.omitRelations();
  assert.equal((await f.command("export")).ok, true);
  const item = await row(f.pm);
  await f.pm.update(item.id, { title: "Pending" });
  const current = workItem(1, { "System.Title": "Remote newer" }, 2);
  delete current.relations;
  f.response("workitemsbatch", { value: [current] });
  f.items.get(1)!.rev = 2;
  assert.equal((await f.command("export")).code, "ADO_CONFLICT");
});

test("command hierarchy failures have stable conflict receipts", async (t) => {
  const f = await fixture(t, [workItem(1), workItem(2)]);
  await f.command("import");
  f.items.get(1)!.relations = [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: `${f.org}/_apis/wit/workItems/2` }];
  f.items.get(2)!.relations = [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: `${f.org}/_apis/wit/workItems/1` }];
  const result = await f.command("import");
  assert.equal(result.code, "ADO_CONFLICT");
  assert.equal(result.exit_code, 4);
  assert.match(result.error!, /cycle/u);
});

test("shared Azure state mappings retain an agreed local status and tags preserve commas", async (t) => {
  const f = await fixture(t);
  f.items.get(1)!.fields["System.Tags"] = "BLUE; With,Comma; blue";
  await f.command("import");
  const item = await row(f.pm);
  assert.deepEqual(item.tags, ["blue", "with,comma"]);
  await f.pm.update(item.id, { status: "blocked", blockedReason: "Waiting for fixture" });
  assert.equal((await f.command("export")).ok, true);
  assert.equal(f.items.get(1)!.fields["System.State"], "Active");
  const before = snapshot(f.pmRoot);
  assert.equal((await f.command("sync")).ok, true);
  assert.equal((await row(f.pm)).status, "blocked");
  assert.deepEqual(snapshot(f.pmRoot), before);
});

test("export refuses import-only filters instead of silently exporting a broader selection", async (t) => {
  const f = await fixture(t);
  for (const options of [{ wiql: "SELECT 1" }, { areaPath: "Project" }, { iterationPath: "Project" }]) {
    assert.equal((await f.command("export", options)).exit_code, 2);
    assert.equal(f.requests.length, 0);
  }
});

test("relation publication server error after creation retains identities across export retries", async (t) => {
  const f = await fixture(t, []);
  const parent = await f.pm.create({ title: "Pending parent", type: "Task" });
  await f.pm.create({ title: "Pending child", type: "Task", parent: parent.item.id });
  f.failPatch(500);
  const result = await f.command("export");
  assert.equal(result.code, "ADO_REMOTE");
  await assertRetainedCreates(f, result);
});

test("terminal states import and failed new relation imports do not persist a false sync base", async (t) => {
  const f = await fixture(t, [workItem(1, { "System.State": "Closed" })]);
  const imported = await f.command("import");
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.equal((await row(f.pm)).status, "closed");
  const before = snapshot(f.pmRoot);
  assert.equal((await f.command("import")).ok, true);
  assert.deepEqual(snapshot(f.pmRoot), before);
  f.items.get(1)!.fields["System.State"] = "Active";
  f.items.get(1)!.rev++;
  assert.equal((await f.command("import")).ok, true);
  f.items.get(1)!.fields["System.State"] = "Closed";
  f.items.get(1)!.rev++;
  const closedAgain = await f.command("import");
  assert.equal(closedAgain.ok, true, JSON.stringify(closedAgain));
  assert.equal((await row(f.pm)).status, "closed");
  f.items.set(2, workItem(2));
  f.items.get(2)!.relations = [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: `${f.org}/_apis/wit/workItems/2` }];
  assert.equal((await f.command("import")).code, "ADO_CONFLICT");
  const failed = (await f.pm.listAllComplete()).items.find((item) => item.ado_id === 2)!;
  assert.equal(failed.ado_sync_base, undefined);
  f.items.get(2)!.relations = [];
  const recovered = await f.command("import");
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.ok((await f.pm.listAllComplete()).items.find((item) => item.ado_id === 2)!.ado_sync_base);
});

/** Verify durable SDK links/history before retrying a partially completed export. */
async function assertRetainedCreates(f: Awaited<ReturnType<typeof fixture>>, result: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["command"]>>) {
  const created = result.plans.filter((plan) => plan.action === "create_remote");
  assert.ok(created.length > 0);
  const linked = (await f.pm.listAllComplete()).items;
  for (const plan of created) {
    const item = linked.find((candidate) => candidate.ado_id === plan.ado_id)!;
    assert.ok(item, "successful creates must be linked before the run stops");
    assert.equal(item.ado_rev, undefined, "creation identity alone does not acknowledge read-back agreement");
    assert.equal(item.ado_project, "Project");
    assert.equal(item.ado_org_url, f.org);
    assert.equal(item.ado_url, `${f.org}/_apis/wit/workItems/${plan.ado_id}`);
    assert.equal(item.ado_sync_base, undefined, "partial publication must not invent a shared base");
    assert.deepEqual(plan.linked_fields, ["ado_id", "ado_project", "ado_org_url", "ado_url"]);
    const history = readFileSync(join(f.pmRoot, "history", `${item.id}.jsonl`), "utf8");
    assert.match(history, /bulk-item-transaction ado-sync-/u);
    assert.match(history, /"path":"\/metadata\/ado_id"/u);
  }
  const count = f.items.size;
  await f.command("export");
  assert.equal(f.items.size, count, "retry must not allocate another work item");
  const posts = f.requests.filter((req) => req.method === "POST" && req.path.includes("/workitems/"));
  assert.equal(posts.length, created.length, "exactly one remote create per exported local item across both runs");
  for (const plan of created) assert.equal((await f.pm.listAllComplete()).items.filter((item) => item.ado_id === plan.ado_id).length, 1);
}

test("another entry's 412 retains created identity across export retries and preserves the existing linked item", async (t) => {
  const f = await fixture(t);
  await f.command("import");
  const existing = await row(f.pm);
  await f.pm.update(existing.id, { title: "Pending linked edit" });
  await f.pm.create({ title: "New unlinked item", type: "Task" });
  const before = Object.fromEntries(Object.entries(snapshot(f.pmRoot)).filter(([key]) => key.includes(existing.id)));
  f.race();
  const result = await f.command("export");
  assert.equal(result.code, "ADO_CONFLICT");
  await assertRetainedCreates(f, result);
  assert.equal(f.items.size, 2, "the one new local item creates exactly one remote work item");
  assert.deepEqual(Object.fromEntries(Object.entries(snapshot(f.pmRoot)).filter(([key]) => key.includes(existing.id))), before);
});

test("planning three linked pairs reads the real SDK tracker once", async (t) => {
  const f = await fixture(t, [workItem(1), workItem(2), workItem(3)]);
  assert.equal((await f.command("import")).ok, true);
  const reader = PmClient.prototype.listAllComplete;
  let reads = 0;
  t.mock.method(PmClient.prototype, "listAllComplete", function (this: PmClient, ...args: Parameters<typeof reader>) {
    reads++;
    return reader.apply(this, args);
  });
  const before = snapshot(f.pmRoot);
  const result = await f.command("sync", { dryRun: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.plans.length, 3);
  assert.equal(reads, 1, "planning must reuse its initial complete tracker snapshot");
  assert.deepEqual(snapshot(f.pmRoot), before);
});

// Resolution regressions share the real SDK tracker and revision-checking HTTP fixture.
import { AdoClient, CommandError, AdoResolutionService, ResolutionRefusal, RevisionConflict, resolutionDigest, resolutionFields, STATE_MAP, type ResolutionPlan, type ResolutionObserver } from "../index.ts";
import { transport } from "../sync.ts";
import { loadResolutionSdk, validateResolutionPlan } from "../resolution.ts";

/** Bind decisions to the existing non-git tracker and REST transport. */
function resolver(f: Awaited<ReturnType<typeof fixture>>, observer?: ResolutionObserver) {
  const config = { orgUrl: f.org, project: "Project", token: "synthetic-token" };
  return new AdoResolutionService(f.pmRoot, "fixture-agent", f.pm, new AdoClient(config, transport), config, runtimeSdk, observer);
}

/** Choose each differing value explicitly, with a selectable winning snapshot. */
function choices(plan: ResolutionPlan, take: "local" | "remote" = "local"): ResolutionPlan {
  return { ...plan, choices: plan.fields.filter((field) => field.local !== field.remote).map(({ field }) => ({ field, take })) };
}

test("resolution plans bind two writers, refuse incomplete decisions before writes and replay without history changes", async (t) => {
  const f = await fixture(t);
  await f.command("import");
  const item = await row(f.pm);
  await f.pm.update(item.id, { title: "Local decision" });
  f.items.set(1, JSON.parse(readFileSync(join(repo, "test/fixtures/resolutions/revision-2.json"), "utf8")) as AdoWorkItem);
  const service = resolver(f);
  const before = snapshot(f.pmRoot);
  const plan = await service.plan(item.id);
  assert.deepEqual(snapshot(f.pmRoot), before, "preview is read-only");
  assert.equal(plan.fields.length, 8);
  assert.equal(plan.fields.find((field) => field.field === "title")!.conflict, true);
  assert.equal(JSON.stringify(plan).includes("Local decision"), false);
  const patches = () => f.requests.filter((req) => req.method === "PATCH").length;
  await assert.rejects(service.apply(plan), { code: "invalid_choices" });
  const complete = choices(plan);
  for (const choice of [ [...complete.choices, complete.choices[0]!], [{ field: "unknown", take: "local" }],
    complete.choices.map((c) => ({ ...c, take: "both" })) ]) {
    await assert.rejects(service.apply({ ...plan, choices: choice }), { code: "invalid_choices" });
  }
  assert.equal(patches(), 0);
  assert.deepEqual(snapshot(f.pmRoot), before);
  const secondWriter = new PmClient({ pmRoot: f.pmRoot, author: "fixture-agent" });
  await secondWriter.comments(item.id, { add: "Second local writer" });
  const second = snapshot(f.pmRoot);
  await assert.rejects(service.apply(complete), { code: "stale_local" });
  assert.deepEqual(snapshot(f.pmRoot), second);
  assert.equal(patches(), 0);
  const fresh = choices(await service.plan(item.id));
  f.items.get(1)!.rev++;
  const remoteBefore = structuredClone(f.items.get(1));
  await assert.rejects(service.apply(fresh), { code: "stale_remote" });
  assert.deepEqual(snapshot(f.pmRoot), second);
  assert.deepEqual(f.items.get(1), remoteBefore);
  assert.equal(patches(), 0);
  const current = choices(await service.plan(item.id));
  const applied = await service.apply(current);
  assert.equal(applied.replayed, false);
  assert.equal(f.items.get(1)!.fields["System.Title"], "Local decision");
  assert.equal((await row(f.pm)).title, "Local decision");
  const after = snapshot(f.pmRoot);
  assert.equal((await service.apply(current)).replayed, true);
  assert.equal(patches(), 1);
  assert.deepEqual(snapshot(f.pmRoot), after);
});

test("remote field choices and same-value plans commit once; malformed coordinates refuse safely", async (t) => {
  const f = await fixture(t);
  await f.command("import");
  const item = await row(f.pm);
  const service = resolver(f);
  const same = await service.plan(item.id);
  assert.ok(same.fields.every((field) => !field.conflict));
  assert.equal((await service.apply(same)).ok, true);
  await f.pm.update(item.id, { title: "Local" });
  f.items.get(1)!.fields["System.Title"] = "Remote";
  f.items.get(1)!.rev++;
  const plan = choices(await service.plan(item.id), "remote");
  assert.equal((await service.apply(plan)).ok, true);
  assert.equal((await row(f.pm)).title, "Remote");
  assert.equal(f.requests.filter((req) => req.method === "PATCH").length, 0);
  const refusalBefore = snapshot(f.pmRoot), refusalRequests = f.requests.length;
  for (const normalization of ["pm-ado/fields/future", null, 1]) await assert.rejects(service.apply({ ...plan, normalization }), { code: "invalid_plan" });
  for (const invalid of [null, [], {}, { ...plan, schema: "future" }, { ...plan, fields: [] },
    { ...plan, remote: { ...plan.remote, id: 0 } }, { ...plan, local: { id: item.id, revision: "wrong" } },
    { ...plan, fields: plan.fields.map((field) => ({ ...field, base: "wrong" })) },
    { ...plan, fields: [null, ...plan.fields.slice(1)] }, { ...plan, fields: plan.fields.map(() => plan.fields[0]) },
    { ...plan, mapping: 5 }, { ...plan, choices: [null] }, { ...plan, scope: { ...plan.scope, org: "legacy" } }]) {
    assert.throws(() => validateResolutionPlan(invalid), ResolutionRefusal);
    await assert.rejects(service.apply(invalid), ResolutionRefusal);
  }
  assert.deepEqual(snapshot(f.pmRoot), refusalBefore); assert.equal(f.requests.length, refusalRequests);
});

test("portable choices reject scope changes, edited digests, missing links and REST races", async (t) => {
  const f = await fixture(t);
  await f.command("import");
  const service = resolver(f);
  await assert.rejects(service.plan("absent"), { code: "scope" });
  const unlinked = await f.pm.create({ title: "Unlinked", type: "Task" });
  await assert.rejects(service.plan(unlinked.item.id), { code: "scope" });
  const item = (await f.pm.listAllComplete()).items.find((row) => row.ado_id === 1)!;
  await f.pm.update(item.id, { title: "Local edit" });
  const plan = choices(await service.plan(item.id));
  await assert.rejects(service.apply({ ...plan, scope: { ref: "0".repeat(64) } }), { code: "scope" });
  const edited = structuredClone(plan);
  edited.fields[0]!.conflict = !edited.fields[0]!.conflict;
  await assert.rejects(service.apply(edited), { code: "invalid_plan" });
  const before = snapshot(f.pmRoot);
  f.race();
  await assert.rejects(service.apply(plan), { code: "ado_partial_apply" });
  assert.equal((await row(f.pm)).title, "Local edit");
  assert.ok((await row(f.pm)).ado_resolution_intent);
  f.omit();
  await assert.rejects(service.plan(item.id), { code: "stale_remote" });
});

test("resolution commands save core Plan bodies and render JSON/TOON without git", async (t) => {
  const f = await fixture(t);
  await f.command("import");
  const item = await row(f.pm);
  await f.pm.update(item.id, { title: "CLI decision" });
  const overrides = { GIT_CEILING_DIRECTORIES: tmpdir(), PATH: f.pmRoot };
  const planned = await f.host(["ado", "resolve-plan", "--item", item.id, "--save", "--json"], overrides);
  assert.equal(planned.code, 0, planned.stderr + planned.stdout);
  const saved = JSON.parse(planned.stdout) as { plan_id: string; plan: ResolutionPlan };
  const plan = choices(saved.plan);
  await f.pm.update(saved.plan_id, { body: JSON.stringify(plan) });
  const applied = await f.host(["ado", "resolve-apply", "--plan", saved.plan_id, "--json"], overrides);
  assert.equal(applied.code, 0, applied.stderr + applied.stdout);
  const portable = join(f.pmRoot, "decision.json");
  writeFileSync(portable, JSON.stringify(plan));
  const replayed = await f.host(["ado", "resolve-apply", "--artifact", portable, "--json"], overrides);
  assert.equal(replayed.code, 0, replayed.stdout + replayed.stderr);
  assert.equal(JSON.parse(replayed.stdout).replayed, true);
  const toon = await f.host(["ado", "resolve-plan", "--item", item.id], overrides);
  assert.equal(toon.code, 0, toon.stderr);
  assert.match(toon.stdout, /schema:.*pm-ado\/resolution\/2/u);
  for (const args of [["ado", "resolve-plan"], ["ado", "resolve-apply"],
    ["ado", "resolve-apply", "--plan", saved.plan_id, "--artifact", portable]]) {
    assert.equal((await f.host([...args, "--json"], overrides)).code, 4);
  }
  writeFileSync(portable, "{");
  assert.equal((await f.host(["ado", "resolve-apply", "--artifact", portable, "--json"])).code, 4);
  assert.equal((await f.host(["ado", "resolve-plan", "--item", item.id, "--json"], { ADO_TOKEN: "" })).code, 4);
});

test("resolution handlers expose typed refusal remedies and core Plan artifacts through the host SDK", async (t) => {
  const f = await fixture(t);
  await f.command("import");
  const item = await row(f.pm);
  const preview = await f.command("resolve-plan", { item: item.id }) as unknown as { ok: boolean; plan: ResolutionPlan };
  assert.equal(preview.ok, true);
  const saved = await f.command("resolve-plan", { item: item.id, save: true }) as unknown as { ok: boolean; plan_id: string; plan: ResolutionPlan };
  assert.equal(saved.ok, true);
  assert.ok(saved.plan_id);
  assert.equal((await f.command("resolve-apply", { plan: saved.plan_id })).ok, true);
  const portable = join(f.pmRoot, "artifact.json");
  writeFileSync(portable, JSON.stringify(preview.plan));
  assert.equal((await f.command("resolve-apply", { artifact: portable })).ok, true);
  writeFileSync(portable, "{");
  assert.equal((await f.command("resolve-apply", { artifact: portable })).code, "invalid_plan");
  assert.equal((await f.command("resolve-apply", { artifact: "missing.json" })).code, "apply_failed");
  assert.equal((await f.command("resolve-plan")).code, "configuration");
  assert.equal((await f.command("resolve-apply")).code, "configuration");
  assert.equal((await f.command("resolve-plan", { withoutSdk: true, item: item.id })).code, "configuration");
  f.env.ADO_STATUS_MAP = "{";
  assert.equal((await f.command("resolve-plan", { item: item.id })).code, "configuration");
  delete f.env.ADO_STATUS_MAP;
  f.env.ADO_TOKEN = "";
  assert.equal((await f.command("resolve-plan", { item: item.id })).code, "configuration");
});

test("resolution preserves agreed status aliases and validates scalar schema before an Azure patch", async (t) => {
  const f = await fixture(t);
  await f.command("import");
  const item = await row(f.pm);
  const service = resolver(f);
  await f.pm.update(item.id, { status: "blocked", blockedReason: "Fixture prerequisite" });
  await f.command("export");
  const plan = await service.plan(item.id);
  assert.equal(plan.fields.find((field) => field.field === "status")!.local, plan.fields.find((field) => field.field === "status")!.remote);
  assert.equal((await service.apply(plan)).ok, true);
  await f.setFields(item.id, {}, ["ado_sync_base"]);
  const legacy = choices(await service.plan(item.id), "remote");
  assert.ok(legacy.fields.every((field) => field.base === null));
  assert.equal((await service.apply(legacy)).ok, true);
  assert.deepEqual(JSON.parse(String((await row(f.pm)).ado_sync_base)).relations, [], "actual equal graph read-backs establish relation agreement");
  assert.equal((await f.command("sync")).ok, true, "existing sync can establish the complete base after scalar resolution");
  const former = await service.plan(item.id);
  await f.pm.update(item.id, { description: "Later decision" });
  assert.equal((await service.apply(choices(await service.plan(item.id)))).ok, true);
  // The immutable history receipt permits older successful plans to replay too.
  assert.equal((await service.apply(legacy)).replayed, true);
  await assert.rejects(service.apply(former), { code: "stale_local" });
  await f.setFields(item.id, { ado_org_url: "https://dev.azure.com/other" });
  await assert.rejects(service.plan(item.id), { code: "scope" });
});

test("resolution clears empty assignees and sanitizes local validation or transport failures", async (t) => {
  const f = await fixture(t);
  await f.command("import");
  const item = await row(f.pm);
  const service = resolver(f);
  delete f.items.get(1)!.fields["System.AssignedTo"];
  f.items.get(1)!.rev++;
  const empty = choices(await service.plan(item.id), "remote");
  assert.equal((await service.apply(empty)).ok, true);
  assert.equal((await row(f.pm)).assignee, undefined);
  await f.pm.update(item.id, { title: "Pending" });
  const plan = choices(await service.plan(item.id));
  f.failPatch(500);
  await assert.rejects(service.apply(plan), { code: "ado_partial_apply" });
  delete f.env.PM_AUTHOR;
  assert.equal((await f.command("resolve-plan")).code, "configuration");
  assert.equal((await f.command("resolve-plan", { item: item.id })).ok, true, "read-only planning does not need a mutation author");
  assert.equal(typeof runtimeSdk.mutateItemWithHistoryContext, "function");
  for (const value of [undefined, null, "failed", { code: "OTHER" }]) assert.equal(ResolutionRefusal.from(value).code, "apply_failed");
  for (const code of ["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND"]) {
    assert.equal(ResolutionRefusal.from(Object.assign(new Error("Missing SDK"), { code })).code, "configuration");
  }
  const config = { orgUrl: f.org, project: "Project", token: "synthetic-token" };
  assert.doesNotThrow(() => new AdoResolutionService(f.pmRoot, "fixture-agent", f.pm, new AdoClient(config, transport), config));
  assert.doesNotThrow(() => new AdoResolutionService(f.pmRoot, "fixture-agent", f.pm, new AdoClient(config, transport), config, undefined));
  assert.throws(() => loadResolutionSdk([]), { code: "configuration" });
  assert.throws(() => loadResolutionSdk(["relative"]), { code: "configuration" });
  assert.equal(typeof loadResolutionSdk([join(tmpdir(), "ado-sdk-unavailable", "module.js"), import.meta.url]).readSettings, "function");
  assert.equal(typeof loadResolutionSdk([join(repo, "package.json")]).readSettings, "function");
});


test("resolution applies terminal and reopen lifecycle evidence while keeping graph metadata", async (t) => {
  const f = await fixture(t);
  await f.command("import");
  const item = await row(f.pm);
  const service = resolver(f);
  f.items.get(1)!.fields["System.State"] = "Closed";
  f.items.get(1)!.rev++;
  assert.equal((await service.apply(choices(await service.plan(item.id), "remote"))).ok, true);
  const closed = await row(f.pm);
  assert.equal(closed.status, "closed");
  assert.ok(closed.completed_at);
  assert.equal(closed.close_reason, "Azure conflict resolution");
  f.items.get(1)!.fields["System.State"] = "New";
  f.items.get(1)!.rev++;
  assert.equal((await service.apply(choices(await service.plan(item.id), "remote"))).ok, true);
  const reopened = await row(f.pm);
  assert.equal(reopened.status, "open");
  assert.equal(reopened.closed_at, undefined);
  assert.equal(reopened.completed_at, undefined);
  assert.equal(reopened.close_reason, undefined);
});


test("resolution digests use portable Unicode key ordering and ignore object insertion order", () => {
  const expected = createHash("sha256").update('{"nested":{"z":1,"ä":2},"z":1,"ä":2}').digest("hex");
  assert.equal(resolutionDigest({ ä: 2, z: 1, nested: { ä: 2, z: 1 } }), expected);
  assert.equal(resolutionDigest({ nested: { z: 1, ä: 2 }, z: 1, ä: 2 }), expected);
  assert.deepEqual(localValues({ title: "T", status: "open", priority: 2, tags: ["ä", "z"] } as Parameters<typeof localValues>[0]).tags, ["z", "ä"]);
});

test("resolution recovery settles after lease expiry following PATCH without a second PATCH", async (t) => {
  const f = await fixture(t);
  await f.command("import");
  const item = await row(f.pm);
  await f.pm.update(item.id, { title: "Reviewed lease recovery" });
  const service = resolver(f);
  const plan = choices(await service.plan(item.id));
  const sdk = runtimeSdk;
  let recorded: Record<string, unknown> | undefined;
  f.afterPatch(async () => {
    const raw = (await f.pm.get(item.id, { depth: "full" })).item.ado_resolution_intent;
    if (typeof raw === "string") recorded = JSON.parse(raw) as Record<string, unknown>;
    const lockPath = join(f.pmRoot, "locks", `${item.id}.lock`);
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    writeFileSync(lockPath, JSON.stringify({ ...lock, created_at: "2000-01-01T00:00:00Z", ttl_seconds: 1 }));
    const peer = await sdk.acquireLockLease(f.pmRoot, item.id, 1, "fixture-peer", true);
    await peer.release();
  });
  await assert.rejects(service.apply(plan), { code: "ado_partial_apply" });
  assert.ok(recorded, "intent must be durable before Azure is called");
  const patch = f.requests.find((request) => request.method === "PATCH")!.body;
  assert.deepEqual(recorded.patch, patch, "durable intent contains the exact wire PATCH");
  assert.equal(recorded.local_revision, plan.local.revision);
  assert.equal(recorded.remote_revision, plan.remote.revision);
  assert.equal(recorded.expected_remote_revision, plan.remote.revision + 1);
  assert.equal((await row(f.pm)).ado_resolution_receipt, undefined);
  assert.ok((await row(f.pm)).ado_resolution_intent);
  assert.equal(f.items.get(1)!.rev, plan.remote.revision + 1);
  const recovered = await resolver(f).apply(plan);
  assert.equal(recovered.ok, true);
  assert.equal(f.requests.filter((request) => request.method === "PATCH").length, 1);
  assert.equal((await row(f.pm)).ado_resolution_intent, undefined);
  assert.equal((await row(f.pm)).ado_resolution_receipt, recovered.decision);
  const settled = snapshot(f.pmRoot);
  assert.equal((await resolver(f).apply(plan)).replayed, true);
  assert.deepEqual(snapshot(f.pmRoot), settled);
});

test("resolution recovery settles after a real tracker write failure following PATCH", async (t) => {
  const f = await fixture(t);
  await f.command("import");
  const item = await row(f.pm);
  await f.pm.update(item.id, { title: "Reviewed write recovery" });
  const service = resolver(f);
  const plan = choices(await service.plan(item.id));
  const located = await runtimeSdk.locateItem(f.pmRoot, item.id);
  assert.ok(located);
  const parent = dirname(located.itemPath);
  const mode = statSync(parent).mode & 0o777;
  let prepared = false;
  f.afterPatch(async () => {
    prepared = typeof (await f.pm.get(item.id, { depth: "full" })).item.ado_resolution_intent === "string";
    chmodSync(parent, 0o500);
  });
  try { await assert.rejects(service.apply(plan), { code: "ado_partial_apply" }); }
  finally { chmodSync(parent, mode); }
  assert.equal(prepared, true, "tracker intent predates the failed settlement write");
  assert.equal((await row(f.pm)).ado_resolution_receipt, undefined);
  const recovered = await resolver(f).apply(plan);
  assert.equal(recovered.ok, true);
  assert.equal(f.requests.filter((request) => request.method === "PATCH").length, 1);
  assert.equal((await row(f.pm)).ado_rev, plan.remote.revision + 1);
  const history = readFileSync(join(f.pmRoot, "history", `${item.id}.jsonl`), "utf8");
  assert.match(history, /ado_resolution_prepare/u);
  assert.match(history, /Settle Azure resolution/u);
});

test("resolution saved Plan body and history contain no organization, project or credential-shaped values", async (t) => {
  const f = await fixture(t);
  await f.command("import");
  const item = await row(f.pm);
  const token = `${"a".repeat(75)}AZDO${"b".repeat(5)}`;
  f.env.ADO_TOKEN = token;
  const saved = await f.command("resolve-plan", { item: item.id, save: true }) as unknown as { ok: boolean; plan_id: string; plan: ResolutionPlan };
  assert.equal(saved.ok, true);
  assert.equal(saved.plan.schema, "pm-ado/resolution/2");
  assert.deepEqual(Object.keys(saved.plan.scope), ["ref"]);
  const body = String((await f.pm.get(saved.plan_id, { depth: "full" })).item.body);
  const history = readFileSync(join(f.pmRoot, "history", `${saved.plan_id}.jsonl`), "utf8");
  for (const persisted of [body, history]) {
    for (const forbidden of [f.org, f.env.ADO_PROJECT!, token, Buffer.from(`:${token}`).toString("base64")]) {
      assert.equal(persisted.includes(forbidden), false, "saved Plan persistence must contain only opaque scope coordinates");
    }
    assert.doesNotMatch(persisted, /\b[A-Za-z0-9]{75}AZDO[A-Za-z0-9]{5}\b|\b[A-Za-z0-9]{52}\b|Basic [A-Za-z0-9+/=]+/u);
  }
});

test("resolution recovery recognizes an applied PATCH despite an error response and fences ambiguous drift", async (t) => {
  const f = await fixture(t);
  await f.command("import");
  const item = await row(f.pm);
  await f.pm.update(item.id, { title: "Ambiguous response" });
  const service = resolver(f);
  const plan = choices(await service.plan(item.id));
  f.afterPatchStatus(500);
  await assert.rejects(service.apply(plan), { code: "ado_partial_apply" });
  const pending = await row(f.pm);
  const expected = plan.remote.revision + 1;
  const peer = await runtimeSdk.acquireLockLease(f.pmRoot, item.id, 60, "fixture-peer");
  const previousWait = process.env.PM_LOCK_WAIT_MS;
  process.env.PM_LOCK_WAIT_MS = "0";
  try { await assert.rejects(resolver(f).apply(plan), { code: "ado_partial_apply" }); }
  finally {
    if (previousWait === undefined) delete process.env.PM_LOCK_WAIT_MS;
    else process.env.PM_LOCK_WAIT_MS = previousWait;
    await peer.release();
  }
  assert.equal(f.items.get(1)!.rev, expected);
  const applied = structuredClone(f.items.get(1)!);
  delete f.items.get(1)!.fields["System.History"];
  await assert.rejects(service.apply(plan), { code: "ado_partial_apply" });
  f.items.set(1, structuredClone(applied));
  f.items.get(1)!.fields["System.Title"] = "Different outcome";
  await assert.rejects(service.apply(plan), { code: "ado_partial_apply" });
  f.items.set(1, structuredClone(applied));
  f.items.get(1)!.rev++;
  await assert.rejects(service.apply(plan), (error: unknown) => error instanceof ResolutionRefusal &&
    error.code === "ado_partial_apply" && error.remedy.includes(`Azure revision ${expected}`) && error.remedy.includes("SAME"));
  f.items.set(1, applied);
  assert.equal((await service.apply(plan)).ok, true);
  assert.equal(f.requests.filter((request) => request.method === "PATCH").length, 1);
  assert.ok(pending.ado_resolution_intent);
});

test("resolution recovery refuses changed local context and substituted intents", async (t) => {
  const f = await fixture(t);
  await f.command("import");
  const item = await row(f.pm);
  await f.pm.update(item.id, { title: "Pending intent" });
  const service = resolver(f);
  const plan = choices(await service.plan(item.id));
  f.failPatch(500);
  await assert.rejects(service.apply(plan), { code: "ado_partial_apply" });
  const raw = String((await row(f.pm)).ado_resolution_intent);
  const intent = JSON.parse(raw) as Record<string, unknown>;
  const different = structuredClone(plan);
  different.choices = different.choices.map((choice) => ({ ...choice, take: "remote" }));
  await assert.rejects(service.apply(different), { code: "ado_partial_apply" });
  for (const invalid of ["{", "null", JSON.stringify({ ...intent, values: {} }),
    ...[undefined, null, 1, [], {}, { ...intent.remote_values as Record<string, unknown>, title: "unreviewed" }].map((remote_values) => JSON.stringify({ ...intent, remote_values })),
    JSON.stringify({ ...intent, patch: [] }), JSON.stringify({ ...intent, expected_remote_revision: 0 }), JSON.stringify({ ...intent, plan_id: "invalid" })]) {
    await f.setFields(item.id, { ado_resolution_intent: invalid });
    await assert.rejects(service.apply(plan), { code: "ado_partial_apply" });
  }
  await f.setFields(item.id, { ado_resolution_intent: raw });
  await assert.rejects(service.apply(plan), { code: "ado_partial_apply" });
  await f.pm.comments(item.id, { add: "Another writer changed context after prepare" });
  const before = snapshot(f.pmRoot);
  await assert.rejects(service.apply(plan), { code: "ado_partial_apply" });
  assert.deepEqual(snapshot(f.pmRoot), before);
  assert.equal(f.requests.filter((request) => request.method === "PATCH").length, 1);
});

test("resolution recovery serializes two writers using the same prepared decision", async (t) => {
  const f = await fixture(t);
  await f.command("import");
  const item = await row(f.pm);
  await f.pm.update(item.id, { title: "Concurrent reviewed decision" });
  const plan = choices(await resolver(f).plan(item.id));
  const results = await Promise.allSettled([resolver(f).apply(plan), resolver(f).apply(plan)]);
  assert.ok(results.some((result) => result.status === "fulfilled" && result.value.ok));
  for (const result of results) if (result.status === "rejected") {
    assert.ok(["ado_partial_apply", "apply_failed"].includes((result.reason as ResolutionRefusal).code));
    assert.equal((result.reason as ResolutionRefusal).exitCode, 4);
  }
  assert.equal((await resolver(f).apply(plan)).replayed, true);
  assert.equal(f.requests.filter((request) => request.method === "PATCH").length, 1);
});

test("resolution recovery handles a peer settling between prepare and settlement", async (t) => {
  const f = await fixture(t);
  await f.command("import");
  const item = await row(f.pm);
  await f.pm.update(item.id, { title: "Peer settlement" });
  const plan = choices(await resolver(f).plan(item.id));
  let peerSettled = false;
  const result = await resolver(f, async (event) => {
    assert.equal(event.phase, "prepared");
    peerSettled = (await resolver(f).apply(plan)).ok;
  }).apply(plan);
  assert.equal(peerSettled, true);
  assert.equal(result.replayed, true);
  assert.equal(f.requests.filter((request) => request.method === "PATCH").length, 1);
});

test("resolution recovery settles local-only decisions and rejects altered PATCH outcomes", async (t) => {
  const f = await fixture(t);
  await f.command("import");
  const item = await row(f.pm);
  f.items.get(1)!.fields["System.Title"] = "Remote selected";
  f.items.get(1)!.rev++;
  const plan = choices(await resolver(f).plan(item.id), "remote");
  const located = await runtimeSdk.locateItem(f.pmRoot, item.id);
  assert.ok(located);
  const parent = dirname(located.itemPath);
  const mode = statSync(parent).mode & 0o777;
  let failed = false;
  const service = resolver(f, async () => {
    if (!failed) { failed = true; chmodSync(parent, 0o500); }
  });
  try { await assert.rejects(service.apply(plan), { code: "ado_partial_apply" }); }
  finally { chmodSync(parent, mode); }
  assert.equal((await resolver(f).apply(plan)).ok, true);
  assert.equal(f.requests.filter((request) => request.method === "PATCH").length, 0);
  await f.pm.update(item.id, { title: "Reviewed new title" });
  const exportPlan = choices(await resolver(f).plan(item.id));
  f.afterPatch(async (remote) => { remote.fields["System.Title"] = "Process rule changed title"; });
  await assert.rejects(resolver(f).apply(exportPlan), { code: "ado_partial_apply" });
  assert.equal((await row(f.pm)).ado_rev, exportPlan.remote.revision);
  f.items.get(1)!.fields["System.Title"] = "Reviewed new title";
  assert.equal((await resolver(f).apply(exportPlan)).ok, true);
  assert.equal(f.requests.filter((request) => request.method === "PATCH").length, 1);
  assert.equal(ResolutionRefusal.from(new RevisionConflict(1, 1, undefined)).code, "stale_remote");
});

test("resolution recovery refuses an intent replaced by another writer between phases", async (t) => {
  const f = await fixture(t);
  await f.command("import");
  const item = await row(f.pm);
  await f.pm.update(item.id, { title: "Guard prepared intent" });
  const plan = choices(await resolver(f).plan(item.id));
  const service = resolver(f, async () => {
    const raw = String((await row(f.pm)).ado_resolution_intent);
    await f.setFields(item.id, { ado_resolution_intent: JSON.stringify(JSON.parse(raw), null, 2) });
  });
  await assert.rejects(service.apply(plan), { code: "ado_partial_apply" });
  assert.equal(f.requests.filter((request) => request.method === "PATCH").length, 0);
});


test("SDK lookup resolves custom nested type folders and keeps the whole-document guard without git", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.command("import")).ok, true);
  const item = await row(f.pm);
  await f.pm.schemaAddType("Delivery", { folder: "planning/deliveries" });
  await f.pm.update(item.id, { type: "Delivery", body: "Whole document guard includes this body." });
  const sdk = loadResolutionSdk();
  const settings = await sdk.readSettings(f.pmRoot);
  const located = await sdk.locateItem(f.pmRoot, item.id, settings.id_prefix, settings.item_format,
    sdk.resolveItemTypeRegistry(settings, sdk.getActiveExtensionRegistrations()).type_to_folder);
  assert.ok(located);
  const document = (await sdk.readLocatedItem(located, { schema: settings.schema })).document;
  const before = snapshot(f.pmRoot);
  const result = await f.host(["ado", "resolve-plan", "--item", item.id, "--json"],
    { GIT_CEILING_DIRECTORIES: tmpdir(), PATH: f.pmRoot });
  assert.equal(result.code, 0, result.stderr);
  const planned = JSON.parse(result.stdout) as { ok: boolean; plan: ResolutionPlan };
  assert.equal(planned.ok, true, result.stdout);
  assert.equal(planned.plan.local.revision, resolutionDigest(document));
  assert.deepEqual(snapshot(f.pmRoot), before);
  await f.pm.update(item.id, { body: "A later body edit invalidates this decision." });
  const changed = snapshot(f.pmRoot);
  await assert.rejects(resolver(f).apply(choices(planned.plan)), { code: "stale_local" });
  assert.deepEqual(snapshot(f.pmRoot), changed);
});

test("SDK sync match refuses a local edit after Azure PATCH without overwriting item or history", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.command("import")).ok, true);
  const item = await row(f.pm);
  await f.pm.update(item.id, { title: "Planned export" });
  let changed: Record<string, string> = {};
  f.afterPatch(async () => {
    await f.pm.update(item.id, { title: "Concurrent local writer", body: "Keep the new context." });
    changed = snapshot(f.pmRoot);
  });
  const result = await f.command("sync");
  assert.equal(result.ok, false);
  assert.equal(result.code, "ADO_CONFLICT");
  assert.equal(result.exit_code, 4);
  assert.match(result.error!, /re-read both trackers/u);
  // The SDK journal is runtime evidence; authoritative item/history bytes stay intact.
  const after = snapshot(f.pmRoot);
  for (const [name, value] of Object.entries(changed)) assert.equal(after[name], value, name);
  assert.equal((await row(f.pm)).title, "Concurrent local writer");
  assert.equal(f.items.get(1)!.fields["System.Title"], "Planned export", "remote success is explicitly partial");
  const converged = await f.command("sync");
  assert.equal(converged.ok, true, JSON.stringify(converged));
  assert.equal((await f.pm.get(item.id, { depth: "full" })).item.body, "Keep the new context.");
  assert.equal(f.items.get(1)!.fields["System.Title"], "Concurrent local writer");
});

test("SDK sync match refuses a stale import before relation and base persistence without git", async (t) => {
  const f = await fixture(t, [workItem(1), workItem(2)]);
  assert.equal((await f.command("import")).ok, true);
  const item = (await f.pm.listAllComplete()).items.find((item) => item.ado_id === 1)!;
  f.items.get(1)!.fields["System.Title"] = "Remote changed";
  f.items.get(1)!.rev++;
  f.items.get(1)!.relations = [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: `${f.org}/_apis/wit/workItems/2` }];
  let changed: Record<string, string> = {};
  f.afterBatch(async () => {
    await f.pm.update(item.id, { title: "Concurrent import edit" });
    changed = snapshot(f.pmRoot);
  });
  const result = await f.host(["ado", "import", "--json"], { GIT_CEILING_DIRECTORIES: tmpdir(), PATH: f.pmRoot });
  assert.equal(result.code, 4, result.stderr);
  const receipt = JSON.parse(result.stdout) as { code: string; error: string };
  assert.equal(receipt.code, "ADO_CONFLICT");
  const after = snapshot(f.pmRoot);
  for (const [name, value] of Object.entries(changed)) assert.equal(after[name], value, name);
  assert.equal((await f.pm.get(item.id)).item.parent, undefined);
});


test("SDK sync failures preserve valid items for invalid state mappings and unusable journal storage", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.command("import", {}, { author: "explicit-agent" })).ok, true);
  const item = await row(f.pm);
  const historyPath = join(f.pmRoot, "history", `${item.id}.jsonl`);
  assert.equal(JSON.parse(readFileSync(historyPath, "utf8").trim().split("\n").at(-1)!).author, "explicit-agent");
  const before = readFileSync(historyPath, "utf8");
  f.env.ADO_STATUS_MAP = '{"New":"unregistered-state"}';
  f.items.get(1)!.rev++;
  const invalid = await f.command("import");
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, "ADO_REMOTE");
  assert.equal(readFileSync(historyPath, "utf8"), before);
  delete f.env.ADO_STATUS_MAP;
  // A filesystem collision exercises real transaction I/O failure, without SDK mocks.
  const journal = join(f.pmRoot, "transactions");
  rmSync(journal, { recursive: true, force: true });
  writeFileSync(journal, "Synthetic storage collision");
  const unusable = await f.command("import");
  assert.equal(unusable.ok, false);
  assert.equal(unusable.code, "ADO_REMOTE");
  assert.equal(readFileSync(historyPath, "utf8"), before);
  rmSync(journal);
  delete f.env.PM_AUTHOR;
  await f.pm.config("project", "set", "author-default", "configured-agent");
  assert.equal((await f.command("import")).ok, true);
  assert.equal(JSON.parse(readFileSync(historyPath, "utf8").trim().split("\n").at(-1)!).author, "configured-agent");
});


test("blocking review: a local status edit between scalar import and close is never overwritten", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.command("import")).ok, true);
  const item = await row(f.pm);
  f.items.get(1)!.fields["System.State"] = "Closed"; f.items.get(1)!.rev++;
  let edited = false;
  const result = await f.observed("import", async (event) => {
    if (!edited && event.boundary === "local" && event.phase === "after" && event.operation === "update") {
      edited = true;
      await f.pm.update(item.id, { status: "blocked", body: "Keep the concurrent status context." });
    }
  });
  assert.equal(edited, true);
  assert.equal(result.ok, false);
  assert.equal(result.code, "ADO_CONFLICT");
  const kept = (await f.pm.get(item.id, { depth: "full" })).item;
  assert.equal(kept.status, "blocked");
  assert.equal(kept.body, "Keep the concurrent status context.");
  assert.equal(kept.closed_at, undefined);
  assert.equal((await f.command("import")).ok, true, "an explicit fresh import can close without losing the context edit");
  assert.equal((await f.pm.get(item.id, { depth: "full" })).item.body, "Keep the concurrent status context.");
});

test("blocking review: local edits during Azure create retain identity and export retry never creates twice", async (t) => {
  const f = await fixture(t, []);
  const { item } = await f.pm.create({ title: "Original export", type: "Task" });
  let edited = false;
  f.afterCreate(async () => {
    if (!edited) { edited = true; await f.pm.update(item.id, { title: "Concurrent export", body: "Keep the local edit." }); }
  });
  const refused = await f.command("export");
  assert.equal(refused.code, "ADO_CONFLICT");
  assert.equal((await row(f.pm)).ado_id, undefined);
  assert.equal((await row(f.pm)).title, "Concurrent export");
  const retried = await f.command("export");
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(f.items.size, 1);
  assert.equal(f.requests.filter((request) => request.method === "POST" && request.path.includes("/workitems/$")).length, 1);
  const linked = (await f.pm.get(item.id, { depth: "full" })).item;
  assert.equal(linked.ado_id, 1); assert.equal(linked.title, "Concurrent export");
  assert.equal(linked.body, "Keep the local edit.");
  assert.equal(f.items.get(1)!.fields["System.Title"], "Concurrent export");
  assert.equal((await f.command("export")).ok, true);
  assert.equal(f.items.size, 1);
});

/** Kill a real SDK command process at one observed boundary; the REST fixture stays alive. */
async function crashAt(f: Awaited<ReturnType<typeof fixture>>, mode: "import" | "export" | "sync", target: number) {
  const child = fork(join(repo, "test/helpers/sync-crash-worker.ts"), [f.pmRoot, mode], {
    cwd: f.root, env: { ...f.env, GIT_CEILING_DIRECTORIES: tmpdir(), PATH: f.pmRoot },
    execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = ""; let hit = false;
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.on("message", (input: unknown) => {
    const message = input as { kind: string; index: number };
    if (message.kind === "boundary") {
      if (message.index === target) { hit = true; child.kill("SIGKILL"); }
      else child.send("continue");
    }
  });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => done({ code, signal }));
  });
  assert.equal(hit, true, stderr);
  assert.equal(exit.signal, "SIGKILL");
}

/** Seed distinct create/import/link/recovery paths with real SDK metadata and server identities. */
async function matrixFixture(t: test.TestContext, scenario: string) {
  const fresh = scenario === "export-create" || scenario === "export-recover";
  const f = await fixture(t, fresh ? [] : ["export-relations", "sync-concurrent-link", "sync-patch-recover"].includes(scenario) ? [workItem(1), workItem(2)] : [workItem()]);
  let mode: "import" | "export" | "sync";
  if (fresh) {
    await f.pm.create({ title: "Matrix export", type: "Task" });
    mode = "export";
    if (scenario === "export-recover") {
      const item = await row(f.pm);
      f.afterCreate(async () => { await f.pm.update(item.id, { title: "Edited during first POST" }); });
      assert.equal((await f.command("export")).code, "ADO_CONFLICT");
    }
  } else if (scenario === "sync-mixed") {
    await f.pm.create({ title: "Matrix unlinked", type: "Task" }); mode = "sync";
  } else {
    assert.equal((await f.command("import")).ok, true);
    if (scenario === "sync-concurrent-link" || scenario === "sync-patch-recover") {
      const linked = (await f.pm.listAllComplete()).items.find((item) => item.ado_id === 1)!;
      await f.pm.update(linked.id, { title: "Matrix concurrent scalar" });
      f.items.get(1)!.relations = [{ rel: "System.LinkTypes.Related", url: `${f.org}/_apis/wit/workItems/2` }];
      f.items.get(1)!.rev++;
      f.response("wiql", { workItems: [{ id: 1 }] });
      mode = "sync";
      if (scenario === "sync-patch-recover") {
        let hit = false;
        const interrupted = await f.observed("sync", (event) => {
          if (event.boundary === "remote" && event.phase === "after" && event.operation.startsWith("PATCH")) { hit = true; throw new Error("Scalar accepted before relation import"); }
        });
        assert.equal(hit, true); assert.equal(interrupted.ok, false);
      }
    } else if (scenario === "export-close") {
      await f.pm.update((await row(f.pm)).id, { status: "closed", closeReason: "Planned terminal export" }); mode = "export";
    } else if (scenario === "import-close") {
      f.items.get(1)!.fields["System.State"] = "Closed"; f.items.get(1)!.rev++; mode = "import";
    } else {
      const items = (await f.pm.listAllComplete()).items;
      const child = items.find((item) => item.ado_id === 1)!;
      await f.pm.update(child.id, { title: "Matrix relation export", parent: items.find((item) => item.ado_id === 2)!.id });
      mode = "export";
    }
  }
  return { f, mode, edited: (await row(f.pm)).id, expected: ["sync-mixed", "export-relations", "sync-concurrent-link", "sync-patch-recover"].includes(scenario) ? 2 : 1 };
}

for (const scenario of ["import-close", "export-close", "export-create", "export-relations", "export-recover", "sync-mixed", "sync-concurrent-link", "sync-patch-recover"]) {
  test(`boundary matrix ${scenario}: every REST/local/intent boundary preserves edits or holds an ambiguous create safely`, async (t) => {
    const probe = await matrixFixture(t, scenario);
    const trace: SyncBoundary[] = [];
    const normal = await probe.f.observed(probe.mode, (event) => { trace.push(event); });
    assert.equal(normal.ok, true, JSON.stringify(normal));
    // Include native SDK lifecycle policy (close clears assignee) in the settled oracle.
    assert.equal((await probe.f.command("sync")).ok, true);
    const intended = new Map([...probe.f.items].map(([id, remote]) => [id, remoteValues(remote, IMPORT_STATE_MAP)]));
    const boundaries = trace.map((event, index) => ({ event, index }));
    assert.ok(boundaries.length >= 6);
    for (const fault of ["edit", "crash"] as const) {
      for (const { event: boundary, index } of boundaries) {
        await t.test(`${fault} ${index} ${boundary.phase} ${boundary.boundary} ${boundary.operation}`, async (sub) => {
          const { f, mode, edited, expected } = await matrixFixture(sub, scenario);
          const label = `Concurrent context ${scenario} ${index}`;
          if (fault === "crash") await crashAt(f, mode, index);
          else {
            let position = 0; let changed = false;
            const result = await f.observed(mode, async () => {
              if (position++ === index) {
                changed = true;
                await f.pm.update(edited, { body: label, comment: [`text=${label}`] });
              }
            });
            assert.equal(changed, true);
            assert.ok(result.ok || result.code === "ADO_CONFLICT", JSON.stringify(result));
            const kept = (await f.pm.get(edited, { depth: "full" })).item;
            assert.equal(kept.body, label);
            assert.ok((kept.comments as { text: string }[]).some((comment) => comment.text === label));
          }
          // Recovery must use ordinary three-way sync, not force the interrupted direction again.
          let retried = await f.command("sync");
          if (!retried.ok && fault === "crash" && boundary.boundary === "intent" && boundary.operation === "dispatched" && boundary.phase === "after" && retried.error?.includes("outcome is uncertain")) {
            // A durable dispatch without an observed POST cannot authorize another create.
            const journal = intentFiles(f).map((file) => JSON.parse(readFileSync(file, "utf8")) as {
              operation: string; state: string; response?: unknown; scope: string; key: string; fields: Record<string, unknown>;
            }).find((intent) => intent.operation === "create" && intent.state === "dispatched" && intent.response === undefined)!;
            assert.ok(journal);
            const creates = f.requests.filter((request) => request.path.includes("/workitems/$")).length;
            assert.equal((await f.command("sync")).code, "ADO_CONFLICT");
            assert.equal(f.requests.filter((request) => request.path.includes("/workitems/$")).length, creates);
            sub.diagnostic("Ambiguous dispatch is held without another POST; recovery resumes only after provider visibility.");
            // If the original request later becomes visible, lookup finishes recovery without a POST.
            const id = Math.max(0, ...f.items.keys()) + 1;
            const marker = `pm-ado-idempotency-${resolutionDigest([journal.scope, journal.key])}`;
            f.items.set(id, workItem(id, { ...journal.fields, "System.Tags": [String(journal.fields["System.Tags"] ?? ""), marker].filter(Boolean).join("; ") }));
            retried = await f.command("sync");
          }
          assert.equal(retried.ok, true, JSON.stringify(retried));
          assert.equal(f.items.size, expected, "no duplicate Azure work item across retries");
          const items = (await f.pm.listAllComplete()).items;
          const linked = items.flatMap((item) => item.ado_id === undefined ? [] : [item.ado_id]);
          assert.equal(new Set(linked).size, expected, "retry completes all local links");
          assert.equal(linked.length, expected, "no duplicate local imports");
          if (fault === "edit") assert.equal((await f.pm.get(edited, { depth: "full" })).item.body, label);
          const count = f.requests.filter((request) => request.method === "POST" && request.path.includes("/workitems/$")).length;
          assert.equal((await f.command("sync")).ok, true);
          for (const [id, expectedValues] of intended) {
            assert.deepEqual(remoteValues(f.items.get(id)!, IMPORT_STATE_MAP), expectedValues, "restart never reverses Azure's intended values");
            if (scenario === "import-close" || scenario === "export-close") {
              for (const request of f.requests.filter((entry) => entry.method === "PATCH")) {
                assert.ok(!(request.body as JsonPatchOperation[]).some((operation) => operation.path === "/fields/System.State" && operation.value !== "Closed"), "no transient reopening PATCH is allowed");
              }
            }
            const kept = (await f.pm.listAllComplete()).items.find((item) => item.ado_id === id)!;
            assert.deepEqual(localValues(kept), expectedValues, "both sides converge to the intended values");
          }
          assert.equal(f.requests.filter((request) => request.method === "POST" && request.path.includes("/workitems/$")).length, count);
        });
      }
    }
  });
}


/** Bind the outbox to the same real recording server, with an optional network-response boundary. */
function outbox(f: Awaited<ReturnType<typeof fixture>>, observer?: SyncObserver, wire = transport) {
  const config = { orgUrl: f.org, project: "Project", token: "synthetic-token" };
  return new SyncOutbox(f.pmRoot, "fixture-agent", config, new AdoClient(config, wire), observer);
}

/** Read a bounded disposable journal directory for acceptance assertions and corruption refusals. */
function intentFiles(f: Awaited<ReturnType<typeof fixture>>) {
  const directory = join(f.pmRoot, "transactions/pm-ado-sync");
  return readdirSync(directory).filter((name) => name.endsWith(".json")).map((name) => join(directory, name));
}

test("outbox creation preserves its first key, resolves cached identities and refuses deleted or corrupt evidence", async (t) => {
  const f = await fixture(t, []);
  const { item } = await f.pm.create({ title: "Journal owner", type: "Task" });
  const service = outbox(f);
  assert.equal(isProtocolTag("ordinary-user-tag"), false);
  assert.equal(isProtocolTag(` PM-ADO-IDEMPOTENCY-${"A".repeat(64)} `), true);
  const first = await service.create(item.id, "Task", { "System.Title": "Original plan" });
  assert.equal(first.recovered, false);
  const file = intentFiles(f)[0]!;
  const raw = readFileSync(file, "utf8");
  const locals = (await f.pm.listAllComplete()).items;
  assert.equal((await service.owners([first.remote], locals)).get(1)!.item, item.id);
  assert.equal((await service.owners([{ id: 99, rev: 1, fields: {}, relations: [] }], locals)).size, 0);
  const intent = JSON.parse(raw) as Record<string, unknown>;
  assert.ok(String(intent.key).startsWith(`${item.id}:create:`));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal((await service.create(item.id, "Bug", { "System.Title": "A later edited plan" })).remote.id, first.remote.id);
  f.items.get(1)!.fields["System.Tags"] = "A manually edited tag";
  assert.equal((await service.create(item.id, "Task", {})).remote.id, 1, "durable identity survives a removed marker");
  f.items.set(1, structuredClone(first.remote));
  for (const patch of [{ id: 99 }, { rev: 0 }, { fields: { "System.Tags": "wrong marker" } }]) {
    writeFileSync(file, JSON.stringify({ ...intent, response: { ...first.remote, ...patch } }));
    await assert.rejects(service.create(item.id, "Task", {}), /acceptance does not prove/u);
  }
  writeFileSync(file, raw);
  f.items.clear();
  await assert.rejects(service.create(item.id, "Task", {}), /Recorded Azure creation is unavailable/u);
  assert.equal(f.requests.filter((request) => request.path.includes("/workitems/$")).length, 1);
  for (const patch of [{ schema: "bad" }, { scope: "wrong" }, { item: "another-item" }, { operation: "patch" }, { key: "bad" }, { state: "invalid" }]) {
    writeFileSync(file, JSON.stringify({ ...intent, ...patch }));
    await assert.rejects(service.create(item.id, "Task", {}), /outbox intent is invalid/u);
  }
  writeFileSync(file, "invalid JSON");
  await assert.rejects(service.create(item.id, "Task", {}), SyntaxError);
  await assert.rejects(service.owners([], locals), SyntaxError);
  writeFileSync(file, raw);
});

test("outbox marker collisions and dishonest or missing lookup rows refuse before any POST", async (t) => {
  for (const kind of ["collision", "wrong-marker", "missing-row"]) {
    await t.test(kind, async (sub) => {
      const f = await fixture(sub, []);
      const { item } = await f.pm.create({ title: "Lookup owner", type: "Task" });
      const service = outbox(f);
      await service.create(item.id, "Task", { "System.Tags": "blue" });
      if (kind === "collision") {
        f.items.set(2, { ...structuredClone(f.items.get(1)!), id: 2 });
        await assert.rejects(service.owners([...f.items.values()], (await f.pm.listAllComplete()).items), /ownership is ambiguous/u);
      }
      else {
        f.response("wiql", { workItems: [{ id: 1 }] });
        if (kind === "missing-row") f.response("workitemsbatch", { value: [] });
        else f.items.get(1)!.fields["System.Tags"] = "wrong marker";
      }
      await assert.rejects(service.create(item.id, "Task", {}), CommandError);
      assert.equal(f.requests.filter((request) => request.path.includes("/workitems/$")).length, 1);
    });
  }
});

test("create dispatch ambiguity never permits a second POST and converges when its marker becomes visible", async (t) => {
  const probe = await matrixFixture(t, "export-create");
  const trace: SyncBoundary[] = [];
  assert.equal((await probe.f.observed("export", (event) => { trace.push(event); })).ok, true);
  const boundary = trace.findIndex((event) => event.boundary === "intent" && event.operation === "dispatched" && event.phase === "after");
  assert.ok(boundary >= 0);
  const { f } = await matrixFixture(t, "export-create");
  await crashAt(f, "export", boundary);
  const pending = await f.command("export");
  assert.equal(pending.code, "ADO_CONFLICT");
  assert.match(pending.error!, /outcome is uncertain/u);
  assert.equal(f.requests.filter((request) => request.path.includes("/workitems/$")).length, 0);
  const intent = JSON.parse(readFileSync(intentFiles(f)[0]!, "utf8")) as { scope: string; key: string; fields: Record<string, unknown> };
  const marker = `pm-ado-idempotency-${resolutionDigest([intent.scope, intent.key])}`;
  // Simulate delayed provider visibility after an outcome that the process could not observe.
  f.items.set(1, workItem(1, { ...intent.fields, "System.Tags": marker }));
  assert.equal((await f.command("export")).ok, true);
  assert.equal(f.items.size, 1);
  assert.equal(f.requests.filter((request) => request.path.includes("/workitems/$")).length, 0);
});

test("conditional outbox PATCH replay proves revision markers, preserves protocol tags and never repeats a comment or link", async (t) => {
  for (const fault of ["before", "after", "foreign", "untagged"]) {
    await t.test(fault, async (sub) => {
      const f = await fixture(sub);
      const initial = structuredClone(f.items.get(1)!);
      if (fault === "untagged") delete initial.fields["System.Tags"];
      else initial.fields["System.Tags"] = `blue; pm-ado-idempotency-${"a".repeat(64)}`;
      f.items.set(1, structuredClone(initial));
      const fields = { "System.Title": "Outbox PATCH", "System.Tags": "green" };
      let interrupted = false;
      const service = outbox(f, async (event) => {
        if (fault !== "after" && !interrupted && event.boundary === "intent" && event.operation === "dispatched" && event.phase === "after") {
          interrupted = true; throw new Error("Interrupted before conditional PATCH");
        }
      }, async (method, url, body, headers) => {
        const response = await transport(method, url, body, headers);
        if (fault === "after" && !interrupted && method === "PATCH") { interrupted = true; throw new Error("Response lost after PATCH"); }
        return response;
      });
      await assert.rejects(service.patch("fixture-owner", initial, fields, []), /Interrupted|Response lost/u);
      const config = { orgUrl: f.org, project: "Project", token: "synthetic-token" };
      if (fault === "foreign") {
        await new AdoClient(config, transport).updateWorkItem(1, 1, { "System.History": "Another writer" });
        await assert.rejects(outbox(f).patch("fixture-owner", initial, fields, []), RevisionConflict);
        assert.equal(JSON.parse(readFileSync(intentFiles(f)[0]!, "utf8")).state, "rejected");
        return;
      }
      const response = await outbox(f).patch("fixture-owner", initial, fields, []);
      assert.equal(response.rev, 2);
      if (fault !== "untagged") assert.match(String(response.fields["System.Tags"]), /pm-ado-idempotency-/u);
      assert.equal((await outbox(f).patch("fixture-owner", initial, fields, [])).rev, 2);
      assert.equal(f.requests.filter((request) => request.method === "PATCH").length, 1);
      if (fault === "after") assert.ok(f.requests.some((request) => request.path.includes("/revisions/2") && request.path.includes("$expand=relations")));
    });
  }
});


test("pending export owners prevent duplicate local imports and refuse competing ownership", async (t) => {
  for (const kind of ["import", "linked-elsewhere", "duplicate-owner"]) {
    await t.test(kind, async (sub) => {
      const f = await fixture(sub, []);
      const owner = (await f.pm.create({ title: "Pending owner", type: "Task" })).item;
      const service = outbox(f);
      await service.create(owner.id, "Task", { "System.Title": "Exported pending object" });
      if (kind === "import") {
        assert.equal((await f.command("import")).ok, true);
        assert.equal((await f.pm.listAllComplete()).items.length, 1);
        assert.equal((await row(f.pm)).id, owner.id);
        assert.equal((await row(f.pm)).ado_id, 1);
      } else {
        const other = (await f.pm.create({ title: "Other owner", type: "Task" })).item;
        if (kind === "linked-elsewhere") {
          await f.setFields(other.id, { ado_id: 1, ado_rev: 1, ado_project: "Project", ado_org_url: f.org });
          assert.equal((await f.command("import")).code, "ADO_CONFLICT");
        } else {
          await service.create(other.id, "Task", { "System.Title": "Another pending object" });
          for (const file of intentFiles(f)) {
            const intent = JSON.parse(readFileSync(file, "utf8")) as { item: string; response: { id: number } };
            if (intent.item === other.id) { intent.response.id = 1; writeFileSync(file, JSON.stringify(intent)); }
          }
          await assert.rejects(service.owners([f.items.get(1)!], (await f.pm.listAllComplete()).items), /ownership is ambiguous/u);
        }
      }
    });
  }
});

test("new imports guard every write after creation and keep concurrent annotations across retry", async (t) => {
  const f = await fixture(t);
  let edited: string | undefined;
  const result = await f.observed("import", async (event) => {
    if (event.boundary === "local" && event.operation === "create" && event.phase === "after") {
      edited = event.item!;
      await f.pm.update(edited, { body: "Preserve context after create", comment: ["text=Concurrent annotation"] });
    }
  });
  assert.equal(result.code, "ADO_CONFLICT");
  assert.ok(edited);
  assert.equal((await f.command("import")).ok, true);
  const items = (await f.pm.listAllComplete()).items;
  assert.equal(items.length, 1);
  assert.equal(items[0]!.id, edited);
  const kept = (await f.pm.get(edited, { depth: "full" })).item;
  assert.equal(kept.body, "Preserve context after create");
  assert.ok((kept.comments as { text: string }[]).some((comment) => comment.text === "Concurrent annotation"));
});

test("sync reconnects its own pending export before import pairing and preserves edited mapped fields", async (t) => {
  const f = await fixture(t);
  const { item } = await f.pm.create({ title: "Original mixed export", type: "Task" });
  let edited = false;
  f.afterCreate(async () => {
    if (!edited) { edited = true; await f.pm.update(item.id, { title: "New mixed context", body: "Keep mixed context" }); }
  });
  assert.equal((await f.command("sync")).code, "ADO_CONFLICT");
  const retried = await f.command("sync");
  assert.equal(retried.ok, true, JSON.stringify(retried));
  const items = (await f.pm.listAllComplete()).items;
  assert.equal(items.length, 2);
  assert.equal(new Set(items.map((entry) => entry.ado_id)).size, 2);
  const kept = (await f.pm.get(item.id, { depth: "full" })).item;
  assert.equal(kept.title, "New mixed context");
  assert.equal(kept.body, "Keep mixed context");
  assert.equal(f.items.get(Number(kept.ado_id))!.fields["System.Title"], "New mixed context");
  assert.equal(f.requests.filter((request) => request.path.includes("/workitems/$")).length, 1);
});


test("unobserved creation recovers its accepted first revision after later remote changes", async (t) => {
  const f = await fixture(t, []);
  const metadata = (await f.pm.create({ title: "Unobserved accepted plan", type: "Task" })).item;
  const values = localValues(metadata);
  const fields = { "System.Title": metadata.title, "System.State": "New", "System.Description": "",
    "System.Tags": "", "System.AssignedTo": "", "Microsoft.VSTS.Common.Priority": 2 };
  let interrupted = false;
  await assert.rejects(outbox(f, (event) => {
    if (!interrupted && event.boundary === "remote" && event.operation === "create" && event.phase === "after") {
      interrupted = true; throw new Error("Lost creation response");
    }
  }).create(metadata.id, "Task", fields, values), /Lost creation response/u);
  const config = { orgUrl: f.org, project: "Project", token: "synthetic-token" };
  await new AdoClient(config, transport).updateWorkItem(1, 1, { "System.History": "A later provider comment" });
  const recovered = await f.command("sync");
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal((await row(f.pm)).ado_id, 1);
  assert.equal((await f.pm.listAllComplete()).items.length, 1);
  assert.equal(f.requests.filter((request) => request.path.includes("/workitems/$")).length, 1);
  assert.ok(f.requests.some((request) => request.path.includes("/revisions/1") && request.path.includes("$expand=relations")));
});


test("pending create recovery refuses competing mapped edits and handles intents without a local projection", async (t) => {
  const f = await fixture(t, []);
  const { item } = await f.pm.create({ title: "Original before create", type: "Task" });
  let edited = false;
  f.afterCreate(async () => { if (!edited) { edited = true; await f.pm.update(item.id, { title: "Local competing title" }); } });
  assert.equal((await f.command("export")).code, "ADO_CONFLICT");
  f.items.get(1)!.fields["System.Title"] = "Remote competing title"; f.items.get(1)!.rev++;
  assert.equal((await f.command("export")).code, "ADO_CONFLICT");
  assert.equal((await row(f.pm)).title, "Local competing title");
  assert.equal(f.items.get(1)!.fields["System.Title"], "Remote competing title");
  assert.equal(f.items.size, 1);
  const legacy = await fixture(t, []);
  const owner = (await legacy.pm.create({ title: "Owner without projection", type: "Task" })).item;
  await legacy.setFields(owner.id, { ado_area_path: "Project\\Area", ado_iteration_path: "Project\\Sprint" });
  await outbox(legacy).create(owner.id, "Task", { "System.Title": owner.title });
  assert.equal((await legacy.command("export")).ok, true);
  assert.equal(legacy.items.size, 1);
});


test("pending PATCH bases ignore unrelated or unapplied records and prove only their own historical effect", async (t) => {
  const f = await fixture(t);
  await f.command("import");
  const local = await row(f.pm);
  const remote = structuredClone(f.items.get(1)!);
  const projection = localValues(local);
  assert.equal((await outbox(f).recoverEffects([remote], [local])).size, 0);
  for (const phase of ["prepared", "dispatched"]) {
    const service = outbox(f, (event) => {
      if (event.boundary === "intent" && event.phase === "after" && event.operation === phase) throw new Error("Interrupted journal");
    });
    const fields = { "System.Title": `Planned ${phase}` };
    await assert.rejects(service.patch(local.id, remote, fields, [], projection), /Interrupted journal/u);
    assert.equal((await outbox(f).recoverEffects([remote], [local])).size, 0);
  }
  f.effect(400);
  await assert.rejects(outbox(f).patch(local.id, remote, { "System.Title": "Rejected projected effect" }, [], projection), CommandError);
  assert.equal((await outbox(f).recoverEffects([remote], [local])).size, 0);
  // An effect made without a local projection cannot silently invent a merge base.
  await outbox(f).patch(local.id, remote, { "System.Title": "Unprojected effect" }, []);
  assert.equal((await outbox(f).recoverEffects([f.items.get(1)!], [local])).size, 0);
  const current = structuredClone(f.items.get(1)!);
  await f.setFields(local.id, { ado_rev: current.rev });
  const inspected = await row(f.pm);
  await outbox(f).patch(local.id, current, { "System.Title": "Known effect" }, [], localValues(inspected));
  const latest = f.items.get(1)!;
  assert.equal((await outbox(f).recoverEffects([latest], [])).size, 0);
  assert.equal((await outbox(f).recoverEffects([latest], [{ ...inspected, ado_rev: "invalid" }])).size, 0);
  assert.equal((await outbox(f).recoverEffects([], [inspected])).size, 0);
  await f.setFields(local.id, { ado_id: 2 });
  assert.equal((await outbox(f).recoverEffects([latest], [await row(f.pm)])).size, 0);
  await f.setFields(local.id, { ado_id: 1, ado_rev: latest.rev });
  assert.equal((await outbox(f).recoverEffects([latest], [await row(f.pm)])).size, 0);
  const directory = join(f.pmRoot, "transactions/pm-ado-sync");
  writeFileSync(join(directory, "note.txt"), "not an intent");
  writeFileSync(join(directory, "foreign.json"), JSON.stringify({ operation: "patch", scope: "another scope" }));
  writeFileSync(join(directory, "other.json"), JSON.stringify({ operation: "another operation" }));
  const recovered = await outbox(f).recoverEffects([latest], [inspected]);
  assert.equal(recovered.get(local.id)!.at(-1)!.accepted.fields["System.Title"], "Known effect");
});

test("two real export processes share one creation intent and never issue another create POST", async (t) => {
  const f = await fixture(t, []);
  const { item } = await f.pm.create({ title: "Concurrent exporters", type: "Task" });
  f.afterCreate(() => new Promise<void>((done) => setTimeout(done, 300)));
  const results = await Promise.all([f.host(["ado", "export", "--json"]), f.host(["ado", "export", "--json"])]);
  for (const result of results) assert.ok(result.code === 0 || result.code === 4, result.stdout + result.stderr);
  assert.equal(f.items.size, 1);
  assert.equal(f.requests.filter((request) => request.path.includes("/workitems/$")).length, 1);
  assert.equal((await f.command("export")).ok, true);
  assert.equal((await f.pm.get(item.id)).item.ado_id, 1);
});


test("successive mapped edits after PATCH recover the entire proven effect chain before retry", async (t) => {
  const f = await fixture(t);
  await f.command("import");
  const local = await row(f.pm);
  await f.pm.update(local.id, { title: "First planned title" });
  let edits = 0;
  f.afterPatch(async () => {
    if (edits < 2) { edits++; await f.pm.update(local.id, { title: `New context ${edits}`, body: `Keep context ${edits}` }); }
  });
  assert.equal((await f.command("sync")).code, "ADO_CONFLICT");
  // Azure may omit empty relation collections in historical snapshots too.
  f.response("2", { ...structuredClone(f.items.get(1)!), relations: undefined });
  assert.equal((await f.command("sync")).code, "ADO_CONFLICT");
  const converged = await f.command("sync");
  assert.equal(converged.ok, true, JSON.stringify(converged));
  const kept = (await f.pm.get(local.id, { depth: "full" })).item;
  assert.equal(kept.title, "New context 2");
  assert.equal(kept.body, "Keep context 2");
  assert.equal(f.items.get(1)!.fields["System.Title"], "New context 2");
  assert.equal(f.requests.filter((request) => request.method === "PATCH").length, 3);
  assert.equal((await f.command("sync")).ok, true);
  assert.equal(f.requests.filter((request) => request.method === "PATCH").length, 3);
});

test("round-2 fixed case: SIGKILL between scalar import and close never reopens Azure on next sync", async (t) => {
  const probe = await matrixFixture(t, "import-close");
  const trace: SyncBoundary[] = [];
  assert.equal((await probe.f.observed("import", (event) => { trace.push(event); })).ok, true);
  const position = trace.findIndex((event) => event.boundary === "local" && event.operation === "update" && event.phase === "after");
  const { f } = await matrixFixture(t, "import-close");
  await crashAt(f, "import", position);
  const before = await row(f.pm);
  const restarted = await f.command("sync");
  assert.equal(restarted.ok, true, JSON.stringify(restarted));
  assert.equal(f.items.get(1)!.fields["System.State"], "Closed", "a stale local status must never reverse the imported close");
  assert.equal((await row(f.pm)).status, "closed");
  assert.equal(JSON.parse(String(before.ado_sync_base)).status, "open", "agreement stayed behind the unfinished close");
  assert.equal(JSON.parse(String((await row(f.pm)).ado_sync_base)).status, "closed");
  assert.equal((await f.command("sync")).ok, true);
  for (const request of f.requests.filter((entry) => entry.method === "PATCH")) {
    assert.ok(!(request.body as JsonPatchOperation[]).some((operation) => operation.path === "/fields/System.State" && operation.value !== "Closed"), "no transient reopening PATCH is allowed");
  }
});

test("round-2 fixed case: definitive create rejection permits a corrected export with a new plan key", async (t) => {
  const f = await fixture(t, []);
  const { item } = await f.pm.create({ title: "Rejected input", type: "Task" });
  f.effect(400);
  const refused = await f.command("export");
  assert.equal(refused.code, "ADO_REMOTE");
  assert.match(refused.error!, /returned 400/u);
  const file = intentFiles(f)[0]!;
  const rejected = JSON.parse(readFileSync(file, "utf8")) as { state: OutboxState; key: string };
  assert.equal(f.items.size, 0);
  await f.pm.update(item.id, { title: "Corrected input" });
  const retried = await f.command("export");
  assert.equal(retried.ok, true, JSON.stringify(retried));
  const observed = JSON.parse(readFileSync(file, "utf8")) as { state: OutboxState; key: string };
  assert.equal(rejected.state, "rejected");
  assert.equal(observed.state, "observed");
  assert.notEqual(observed.key, rejected.key);
  assert.equal(f.items.size, 1);
  assert.equal(f.items.get(1)!.fields["System.Title"], "Corrected input");
  assert.equal(f.requests.filter((request) => request.path.includes("/workitems/$")).length, 2, "one rejected request and one accepted creation");
  assert.equal((await f.command("sync")).ok, true);
  assert.equal(f.items.size, 1);
});

/** Independent deterministic source of fault/input sequences for the durable model. */
function modelRandom(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state >>> 8; };
}

/** Inspect actual private journal knowledge; never substitute SDK state or transport. */
function modelIntent(f: Awaited<ReturnType<typeof fixture>>, owner: string, operation: "create" | "patch", title?: string) {
  return intentFiles(f).map((file) => JSON.parse(readFileSync(file, "utf8")) as {
    item: string; operation: string; state: OutboxState; key: string; scope: string; type: string; fields: Record<string, unknown>;
  }).find((intent) => intent.item === owner && intent.operation === operation && (title === undefined || intent.fields["System.Title"] === title))!;
}

test("round-2 model: random create outcomes and corrected plans preserve identity and converge after proof", async (t) => {
  const f = await fixture(t, []);
  const random = modelRandom(0x10262026);
  const outcomes = ["success", "http-500", "http-408", "http-302", "network-before", "network-after", "server-after", "malformed", "crash-prepared", "crash-dispatched", "crash-after", "crash-observed"] as const;
  const refusals = [400, 401, 403, 404, 409, 412, 422, 429];
  let rejected = 0; let held = 0; let calls = 0;
  for (let sequence = 0; sequence < 36; sequence++) {
    const owner = `model-create-${sequence}`;
    let fields = { "System.Title": `Original ${sequence}`, "System.Tags": "model" };
    let type = "Task";
    const prefix = random() % 4;
    const outcome = outcomes[sequence < outcomes.length ? sequence : random() % outcomes.length]!;
    const before = f.items.size;
    for (let attempt = 0; attempt < prefix; attempt++) {
      f.effect(refusals[(sequence + attempt) % refusals.length]!);
      await assert.rejects(outbox(f).create(owner, type, fields), CommandError);
      const refused = modelIntent(f, owner, "create");
      assert.equal(refused.state, "rejected", "a definitive refusal must not become an unknown dispatch");
      assert.equal(f.items.size, before);
      const previousKey = refused.key;
      fields = { ...fields, "System.Title": `Corrected ${sequence}-${attempt}` };
      type = attempt % 2 === 0 ? "Bug" : "Task";
      if (attempt === prefix - 1) assert.ok(previousKey.includes(":create:"));
      rejected++;
    }
    if (outcome.startsWith("http-")) f.effect(Number(outcome.slice(5)));
    else if (outcome === "network-before" || outcome === "network-after" || outcome === "server-after" || outcome === "malformed") f.effect(outcome);
    let interrupted = false;
    const service = outbox(f, (event) => {
      if (!interrupted && (outcome === `crash-${event.operation}` && event.boundary === "intent" && event.phase === "after" ||
          outcome === "crash-after" && event.boundary === "remote" && event.operation === "create" && event.phase === "after")) {
        interrupted = true; throw new Error("Model crash at a durable boundary");
      }
    });
    const attemptsBefore = f.requests.filter((request) => request.path.includes("/workitems/$")).length;
    if (outcome === "success") await service.create(owner, type, fields);
    else await assert.rejects(service.create(owner, type, fields));
    let intent = modelIntent(f, owner, "create");
    const expected = outcome === "success" || outcome === "crash-observed" ? "observed" : outcome === "crash-prepared" ? "prepared" : "dispatched";
    assert.equal(intent.state, expected);
    const marker = `pm-ado-idempotency-${resolutionDigest([intent.scope, intent.key])}`;
    const visible = () => [...f.items.values()].filter((item) => String(item.fields["System.Tags"]).split(";").some((tag) => tag.trim() === marker));
    const dispatchedAttempts = f.requests.filter((request) => request.path.includes("/workitems/$")).length;
    if (expected === "dispatched" && visible().length === 0) {
      // Unknown dispatch cannot be made safe by changing inputs or blindly retrying.
      for (let query = 0; query < 1 + random() % 3; query++) {
        await assert.rejects(outbox(f).create(owner, "Task", { "System.Title": "A later unconfirmed edit" }), /outcome is uncertain/u);
        assert.equal(modelIntent(f, owner, "create").key, intent.key);
        assert.equal(f.requests.filter((request) => request.path.includes("/workitems/$")).length, dispatchedAttempts);
      }
      held++;
      // The model now supplies authoritative provider visibility of the original key.
      // This is an explicit fairness condition, not permission to resend an unsent POST.
      const id = Math.max(0, ...f.items.keys()) + 1;
      f.items.set(id, workItem(id, { ...intent.fields, "System.WorkItemType": intent.type,
        "System.Tags": [String(intent.fields["System.Tags"]), marker].join("; ") }));
    }
    const accepted = await outbox(f).create(owner, type, fields);
    intent = modelIntent(f, owner, "create");
    assert.equal(intent.state, "observed", "no rejected or provably accepted plan remains stuck");
    assert.equal(visible().length, 1);
    assert.equal(f.items.size, before + 1);
    assert.equal(accepted.remote.fields["System.Title"], fields["System.Title"]);
    const settledCalls = f.requests.filter((request) => request.path.includes("/workitems/$")).length;
    for (let replay = 0; replay < 1 + random() % 3; replay++) assert.equal((await outbox(f).create(owner, "Task", { "System.Title": "Later edit cannot allocate another identity" })).remote.id, accepted.remote.id);
    assert.equal(f.requests.filter((request) => request.path.includes("/workitems/$")).length, settledCalls);
    assert.ok(settledCalls - attemptsBefore <= 1, "all replays together perform at most one non-rejected POST");
    calls += settledCalls - attemptsBefore;
  }
  t.diagnostic(`36 seeded create sequences; ${rejected} definitive rejections corrected; ${held} ambiguous outcomes held until proof; ${calls} non-rejected POST attempts; 36 unique observed identities.`);
});

test("round-2 model: random conditional PATCH outcomes recover exactly one link and history effect", async (t) => {
  const f = await fixture(t);
  const random = modelRandom(0x52621026);
  const outcomes = ["success", "http-500", "http-408", "http-302", "network-before", "network-after", "server-after", "malformed", "crash-prepared", "crash-dispatched", "crash-observed"] as const;
  let rejected = 0;
  for (let sequence = 0; sequence < 33; sequence++) {
    const owner = `model-patch-${sequence}`;
    const original = structuredClone(f.items.get(1)!);
    const fields = { "System.Title": `Patch plan ${sequence}` };
    const relation: JsonPatchOperation = { op: "add", path: "/relations/-", value: { rel: "System.LinkTypes.Related", url: `${f.org}/_apis/wit/workItems/${100 + sequence}` } };
    if (random() % 2 === 0) {
      f.effect(400);
      await assert.rejects(outbox(f).patch(owner, original, fields, [relation]), CommandError);
      assert.equal(modelIntent(f, owner, "patch", fields["System.Title"]).state, "rejected");
      assert.equal(f.items.get(1)!.rev, original.rev);
      rejected++;
    }
    const outcome = outcomes[sequence < outcomes.length ? sequence : random() % outcomes.length]!;
    if (outcome.startsWith("http-")) f.effect(Number(outcome.slice(5)));
    else if (outcome === "network-before" || outcome === "network-after" || outcome === "server-after" || outcome === "malformed") f.effect(outcome);
    let interrupted = false;
    const service = outbox(f, (event) => {
      if (!interrupted && outcome === `crash-${event.operation}` && event.boundary === "intent" && event.phase === "after") {
        interrupted = true; throw new Error("Model PATCH crash");
      }
    });
    if (outcome === "success") await service.patch(owner, original, fields, [relation]);
    else await assert.rejects(service.patch(owner, original, fields, [relation]));
    const response = await outbox(f).patch(owner, original, fields, [relation]);
    assert.equal(response.rev, original.rev + 1);
    assert.equal(modelIntent(f, owner, "patch", fields["System.Title"]).state, "observed");
    assert.equal(f.items.get(1)!.rev, original.rev + 1, "link and generated comment commit only once");
    assert.equal(f.items.get(1)!.relations!.filter((link) => link.url === (relation.value as AdoRelation).url).length, 1);
    assert.equal(f.items.get(1)!.fields["System.Title"], fields["System.Title"]);
    const calls = f.requests.filter((request) => request.method === "PATCH").length;
    for (let replay = 0; replay < 1 + random() % 3; replay++) assert.equal((await outbox(f).patch(owner, original, fields, [relation])).rev, response.rev);
    assert.equal(f.requests.filter((request) => request.method === "PATCH").length, calls);
  }
  assert.equal(f.items.size, 1);
  assert.equal(f.items.get(1)!.relations!.length, 33);
  t.diagnostic(`33 seeded PATCH sequences; ${rejected} definitive refusals retried; 33 accepted revisions, 33 unique links and no duplicate history effects.`);
});

test("round-2 rejection crash boundaries preserve known refusals and hold lost proof without another POST", async (t) => {
  const probe = await fixture(t, []);
  await probe.pm.create({ title: "Rejected crash input", type: "Task" });
  probe.effect(400);
  const trace: SyncBoundary[] = [];
  assert.equal((await probe.observed("export", (event) => { trace.push(event); })).code, "ADO_REMOTE");
  const positions = trace.flatMap((event, index) => event.boundary === "remote" && event.operation === "create" && event.phase === "after" ||
    event.boundary === "intent" && event.operation === "rejected" ? [{ event, index }] : []);
  assert.equal(positions.length, 3);
  for (const { event, index } of positions) {
    await t.test(`${event.phase} ${event.boundary} ${event.operation}`, async (sub) => {
      const f = await fixture(sub, []);
      const { item } = await f.pm.create({ title: "Rejected crash input", type: "Task" });
      f.effect(400);
      await crashAt(f, "export", index);
      await f.pm.update(item.id, { title: "Corrected crash input" });
      const saved = modelIntent(f, item.id, "create");
      if (event.boundary === "intent" && event.phase === "after") {
        assert.equal(saved.state, "rejected");
        const retry = await f.command("sync");
        assert.equal(retry.ok, true, JSON.stringify(retry));
        assert.equal(f.items.size, 1);
        assert.equal(f.items.get(1)!.fields["System.Title"], "Corrected crash input");
        assert.equal(f.requests.filter((request) => request.path.includes("/workitems/$")).length, 2);
      } else {
        assert.equal(saved.state, "dispatched", "a rejection response lost before durable recording is unknown");
        assert.equal((await f.command("sync")).code, "ADO_CONFLICT");
        assert.equal((await f.command("sync")).code, "ADO_CONFLICT");
        assert.equal(f.items.size, 0);
        assert.equal(f.requests.filter((request) => request.path.includes("/workitems/$")).length, 1);
      }
    });
  }
});

test("round-2 undispatched create retries use corrected inputs and preserve the latest local context", async (t) => {
  const f = await fixture(t, []);
  const { item } = await f.pm.create({ title: "Before undispatched interruption", type: "Task" });
  let interrupted = false;
  await f.observed("export", (event) => {
    if (!interrupted && event.boundary === "intent" && event.operation === "prepared" && event.phase === "after") {
      interrupted = true; throw new Error("Stop before any dispatch");
    }
  });
  assert.equal(modelIntent(f, item.id, "create").state, "prepared");
  assert.equal(f.items.size, 0);
  await f.pm.update(item.id, { title: "Latest undispatched input", body: "Keep the latest context" });
  const result = await f.command("export", { type: "Bug" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.items.get(1)!.fields["System.Title"], "Latest undispatched input");
  assert.equal(f.items.get(1)!.fields["System.WorkItemType"], "Bug");
  const kept = (await f.pm.get(item.id, { depth: "full" })).item;
  assert.equal(kept.title, "Latest undispatched input");
  assert.equal(kept.body, "Keep the latest context");
  assert.equal(f.requests.filter((request) => request.path.includes("/workitems/$")).length, 1);
});
/** Seeded operation sequences use SDK storage as the normalization oracle, never a handwritten trim/CRLF model. */
test("500 seeded import/export/sync sequences preserve every owned field, relationships and older replay refusals", async (t) => {
  const f = await fixture(t, [workItem(1), workItem(2)]);
  f.items.get(1)!.relations = [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: `${f.org}/_apis/wit/workItems/2` },
    { rel: "System.LinkTypes.Related", url: `${f.org}/_apis/wit/workItems/2` }];
  f.items.get(2)!.relations = [{ rel: "System.LinkTypes.Hierarchy-Forward", url: `${f.org}/_apis/wit/workItems/1` },
    { rel: "System.LinkTypes.Related", url: `${f.org}/_apis/wit/workItems/1` }];
  assert.equal((await f.command("import")).ok, true);
  const initial = (await f.pm.listAllComplete()).items;
  const ids = new Map(initial.map((item) => [Number(item.ado_id), item.id]));
  // Independent reference tracker applies desired native state through the SDK.
  const modelRoot = mkdtempSync(join(tmpdir(), "ado-reference-"));
  t.after(() => rmSync(modelRoot, { recursive: true, force: true }));
  const model = new PmClient({ cwd: modelRoot, pmRoot: join(modelRoot, ".agents/pm"), author: "fixture-agent" });
  await model.run("init", { prefix: "model" });
  const reference = new Map<number, string>();
  for (const item of initial) reference.set(Number(item.ado_id), (await model.create({ title: item.title, type: "Task", description: item.description,
    priority: item.priority, tags: JSON.stringify(item.tags), assignee: item.assignee })).item.id);
  await model.update(reference.get(1)!, { parent: reference.get(2)!, dep: [`id=${reference.get(2)},kind=related,source_kind=System.LinkTypes.Related`] });
  let seed = 0x5a17c0de;
  /** Deterministic bounded pseudo-random choices make failures reproducible. */
  const random = (bound: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % bound; };
  const statuses = Array.from({ length: 5 }, (_, index) => `stage_${random(100000)}_${index}`);
  const roles = [["active"], ["blocked"], ["terminal", "terminal_done"], ["terminal", "terminal_canceled"], ["draft"]];
  for (let index = 0; index < statuses.length; index++) {
    await f.pm.schemaAddStatus(statuses[index]!, { role: roles[index] });
    await model.schemaAddStatus(statuses[index]!, { role: roles[index] });
  }
  const registry = resolveRuntimeStatusRegistry((await readSettings(f.pmRoot)).schema);
  f.env.ADO_STATUS_MAP = JSON.stringify(Object.fromEntries(statuses.map((status, index) => [`Remote${index}`, status])));
  f.env.ADO_EXPORT_STATE_MAP = JSON.stringify(Object.fromEntries(statuses.map((status, index) => [status, `Remote${index}`])));
  await model.update(reference.get(2)!, { dep: [`id=${reference.get(1)},kind=related,source_kind=System.LinkTypes.Related`] });
  let remoteMirrored = true, localMirrored = true;
  let mirrorMetadata: unknown;
  const archive: AdoWorkItem[] = [];
  const modeCounts: Record<string, number> = { import: 0, export: 0, sync: 0 };
  for (let sequence = 0; sequence < 500; sequence++) {
    const remote = f.items.get(1)!;
    const mode = ["import", "export", "sync"][random(3)]!;
    modeCounts[mode]++;
    const title = `Sequence ${sequence} ${random(1000)}`;
    const description = random(2) ? `  details ${sequence}\r\nnext line  ` : `details ${sequence}\nnext line`;
    const priority = random(5);
    const statusIndex = random(5), status = statuses[statusIndex]!;
    const closeReason = registry.terminal_statuses.has(status) ? "Model transition" : undefined;
    const tags = ["blue", `tag-${random(7)}`];
    const assignee = `agent-${random(5)}@example.invalid`;
    const area = `Project\\Area${random(4)}`, iteration = `Project\\Sprint${random(4)}`;
    const beforeRemote = structuredClone(remote);
    archive.push(beforeRemote);
    await model.update(reference.get(1)!, { title, description, status, closeReason, priority, tags: JSON.stringify(tags), assignee });
    if (mode === "export") {
      await f.pm.update(ids.get(1)!, { title, description, status, closeReason, priority, tags: JSON.stringify(tags), assignee });
      await f.setFields(ids.get(1)!, { ado_area_path: area, ado_iteration_path: iteration });
    } else {
      remote.rev++;
      Object.assign(remote.fields, { "System.Title": title, "System.Description": description, "Microsoft.VSTS.Common.Priority": priority,
        "System.Tags": tags.join("; "), "System.State": `Remote${statusIndex}`, "System.AssignedTo": { uniqueName: assignee }, "System.AreaPath": area, "System.IterationPath": iteration });
    }
    // Azure related links export symmetrically; additive import materializes the inverse on its next import.
    if (mode === "import" && remoteMirrored && !localMirrored) {
      await model.update(reference.get(2)!, { dep: [`id=${reference.get(1)},kind=related,source_kind=System.LinkTypes.Related`] });
      localMirrored = true;
    }
    if (mode !== "import") remoteMirrored = true;
    const result = await f.command(mode);
    if (!result.ok) {
      assert.equal(result.code, "ADO_CONFLICT", `seed ${seed} sequence ${sequence}: ${JSON.stringify(result)}`);
      const normalized = (await model.get(reference.get(1)!, { depth: "full" })).item;
      const accepted = f.items.get(1)!;
      Object.assign(accepted.fields, { "System.Description": normalized.description ?? "", "System.AssignedTo": normalized.assignee ?? "" });
      accepted.rev++;
      assert.equal((await f.command("import")).ok, true);
    }
    const actualRows = (await f.pm.listAllComplete()).items;
    const expectedRows = (await model.listAllComplete()).items;
    const actual = actualRows.find((item) => item.id === ids.get(1))!;
    const expected = expectedRows.find((item) => item.id === reference.get(1))!;
    const actualOther = actualRows.find((item) => item.id === ids.get(2))!;
    const expectedOther = expectedRows.find((item) => item.id === reference.get(2))!;
    for (const field of ["title", "description", "status", "priority", "tags", "assignee", "parent"] as const) assert.deepEqual(actualOther[field], expectedOther[field], `${sequence}: peer ${field}`);
    assert.deepEqual(actualOther.dependencies?.map((edge) => ({ id: reference.get(1), kind: edge.kind, source_kind: edge.source_kind })),
      expectedOther.dependencies?.map((edge) => ({ id: edge.id, kind: edge.kind, source_kind: edge.source_kind })));
    if (localMirrored && mirrorMetadata === undefined) mirrorMetadata = actualOther.dependencies;
    if (localMirrored) assert.deepEqual(actualOther.dependencies, mirrorMetadata);
    for (const field of ["title", "description", "status", "priority", "tags", "assignee"] as const) assert.deepEqual(actual[field], expected[field], `${sequence}: ${field}`);
    assert.equal(actual.parent, ids.get(2));
    assert.equal(actual.dependencies?.length, expected.dependencies?.length);
    assert.deepEqual(actual.dependencies?.map((edge) => ({ id: reference.get(2), kind: edge.kind, source_kind: edge.source_kind })),
      expected.dependencies?.map((edge) => ({ id: edge.id, kind: edge.kind, source_kind: edge.source_kind })));
    // Creation metadata belongs to each tracker; it must stay stable within its own tracker.
    assert.deepEqual(actual.dependencies, initial.find((item) => item.id === ids.get(1))!.dependencies);
    assert.equal(actual.ado_id, 1); assert.equal(actual.ado_type, "Task");
    assert.equal(actual.ado_org_url, f.org); assert.equal(actual.ado_project, "Project");
    assert.equal(actual.ado_url, `${f.org}/_apis/wit/workItems/1`);
    assert.equal(actual.ado_area_path, area); assert.equal(actual.ado_iteration_path, iteration);
    assert.equal(actual.ado_rev, f.items.get(1)!.rev);
    const before = snapshot(f.pmRoot);
    assert.equal((await f.command(mode)).ok, true);
    assert.deepEqual(snapshot(f.pmRoot), before, `${sequence}: exact replay must not mutate history`);
    if (sequence % 10 === 0) {
      const latest = f.items.get(1)!;
      const old = archive[random(archive.length)]!;
      f.items.set(1, structuredClone(old));
      const replay = await f.command("import");
      assert.equal(replay.ok, false, `${sequence}: older revision input must be refused`);
      assert.deepEqual(snapshot(f.pmRoot), before);
      f.items.set(1, latest);
    }
  }
  t.diagnostic(JSON.stringify({ sequences: 500, mode_counts: modeCounts, exact_replays: 500, older_replays: 50 }));
});

test("refresh-plan host JSON and TOON work without git and leave item/history bytes unchanged", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.command("import")).ok, true);
  const before = snapshot(f.pmRoot);
  const env = { PATH: "", GIT_CEILING_DIRECTORIES: tmpdir() };
  const json = await f.host(["ado", "refresh-plan", "--fields", "title,status,relations", "--json"], env);
  assert.equal(json.code, 0, json.stdout + json.stderr);
  const plan = JSON.parse(json.stdout) as { cost: { pm_mutations: number; hydrate_reads: number }; unchanged: number[] };
  assert.equal(plan.cost.pm_mutations, 0); assert.equal(plan.cost.hydrate_reads, 0); assert.deepEqual(plan.unchanged, [1]);
  const toon = await f.host(["ado", "refresh-plan", "--fields", "title,status", "--output-format", "toon"], env);
  assert.equal(toon.code, 0, toon.stdout + toon.stderr); assert.match(toon.stdout, /pm_mutations: 0/u);
  const refused = await f.host(["ado", "refresh-plan", "--fields", "unknown", "--json"], env);
  assert.equal(refused.code, 2); assert.equal(JSON.parse(refused.stdout).code, "invalid_input");
  assert.deepEqual(snapshot(f.pmRoot), before);
});

test("older remote revision snapshots refuse import, export and sync before any mutations", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.command("import")).ok, true);
  f.items.get(1)!.rev = 2; f.items.get(1)!.fields["System.Title"] = "Newer snapshot";
  assert.equal((await f.command("import")).ok, true);
  const before = snapshot(f.pmRoot);
  f.items.get(1)!.rev = 1; f.items.get(1)!.fields["System.Title"] = "Older snapshot";
  for (const mode of ["import", "export", "sync"]) {
    assert.equal((await f.command(mode)).code, "ADO_CONFLICT"); assert.deepEqual(snapshot(f.pmRoot), before);
  }
  await assert.rejects(resolver(f).plan((await row(f.pm)).id), { code: "stale_remote" });
});

/** Independent projections for the two-sided, interruptible three-way reference model. */
test("round-3 model: 512 two-sided sequences preserve edits and witness every base advance", async (t) => {
  const f = await fixture(t, [1, 2, 3].map((id) => workItem(id, { "System.AssignedTo": "" })));
  assert.equal((await f.command("import")).ok, true);
  const rows = (await f.pm.listAllComplete()).items;
  const root = rows[0]!, remoteId = Number(root.ado_id);
  const peers = rows.filter((item) => item.id !== root.id);
  const byId = new Map(rows.map((item) => [item.id, Number(item.ado_id)]));
  f.response("wiql", { workItems: [{ id: remoteId }] });
  const options = { limit: 1 };
  const modelSettings = await readSettings(f.pmRoot);
  const located = (await runtimeSdk.locateItem(f.pmRoot, root.id, modelSettings.id_prefix, modelSettings.item_format, runtimeSdk.resolveItemTypeRegistry(modelSettings).type_to_folder))!;
  /** Read the real authoritative document using the SDK parser without command presentation overhead. */
  const readModelItem = async () => (await runtimeSdk.readLocatedItem(located, { schema: modelSettings.schema,
    extensionFieldNames: ["ado_id", "ado_rev", "ado_project", "ado_org_url", "ado_sync_base", "ado_area_path", "ado_iteration_path", "ado_url", "ado_type", "ado_sync_intent"] })).document.metadata;
  type State = Record<string, string | number | string[]>;
  /** Reference local projection reads native storage, independently of the production graph adapter. */
  const local = async (): Promise<State> => {
    const item = await readModelItem();
    const relations = (item.dependencies ?? []).filter((edge) => edge.kind === "related").map((edge) => JSON.stringify(["System.LinkTypes.Related", byId.get(edge.id)]));
    if (item.parent !== undefined) relations.push(JSON.stringify(["System.LinkTypes.Hierarchy-Reverse", byId.get(item.parent)]));
    return { title: item.title!, description: item.description ?? "", status: item.status!, priority: item.priority!,
      tags: [...item.tags!].sort(), assignee: item.assignee ?? "", ado_area_path: String(item.ado_area_path ?? ""), ado_iteration_path: String(item.ado_iteration_path ?? ""), relations: [...new Set(relations)].sort() };
  };
  /** Reference Azure projection reads the recording server's authoritative objects. */
  const remote = (): State => {
    const item = f.items.get(remoteId)!, fields = item.fields;
    return { title: String(fields["System.Title"]), description: String(fields["System.Description"] ?? ""),
      status: ({ New: "open", Active: "in_progress", Closed: "closed", Blocked: "blocked" } as Record<string, string>)[String(fields["System.State"])],
      priority: Number(fields["Microsoft.VSTS.Common.Priority"]), tags: String(fields["System.Tags"] ?? "").split(";").map((v) => v.trim()).filter(Boolean).sort(),
      assignee: String(fields["System.AssignedTo"] ?? ""), ado_area_path: String(fields["System.AreaPath"] ?? ""), ado_iteration_path: String(fields["System.IterationPath"] ?? ""),
      relations: (item.relations ?? []).map((edge) => JSON.stringify([edge.rel, Number(edge.url.split("/").at(-1))])).sort() };
  };
  /** Equality is defined by the independent canonical reference representation. */
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  /** Read the persisted base without using its production decoder. */
  const base = async (): Promise<State> => JSON.parse(String((await readModelItem()).ado_sync_base));
  let seed = 0x37a9c521;
  /** Reproducible LCG covers edits, directions and interruption positions. */
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  let pending = new Map<string, Map<string, State[string]>>();
  const witnesses = new Map<string, Set<string>>();
  let invariantFailure: Error | undefined;
  /** Only paired actual reads can certify a new value; requests and accepted snapshots cannot. */
  const witness = async () => {
    const l = await local(), r = remote();
    for (const key of Object.keys(l)) if (same(l[key], r[key])) {
      if (!witnesses.has(key)) witnesses.set(key, new Set());
      witnesses.get(key)!.add(JSON.stringify(l[key]));
      for (const [side, value] of pending.get(key) ?? []) if (same(value, l[key])) pending.get(key)!.delete(side);
    }
  };
  /** Every newly published base key must have a real post-operation equality witness. */
  const invariant = async () => {
    const b = await base();
    for (const [key, value] of Object.entries(b)) if (!["ado_base_partial", "ado_agreed_revisions"].includes(key) && !witnesses.get(key)?.has(JSON.stringify(value))) {
      invariantFailure = new Error(`unwitnessed base ${key}: ${JSON.stringify(value)}`); throw invariantFailure;
    }
  };
  await witness();
  const wireNames: Record<string, string> = { title: "System.Title", description: "System.Description", status: "System.State", priority: "Microsoft.VSTS.Common.Priority", tags: "System.Tags", assignee: "System.AssignedTo", ado_area_path: "System.AreaPath", ado_iteration_path: "System.IterationPath" };
  /** Explicit operator resolution after a reported conflict aligns Azure to the retained local state. */
  const resolve = async () => {
    const l = await local(), item = f.items.get(remoteId)!;
    const saved = await readModelItem();
    if (same(l, remote()) && Object.keys(l).every((key) => same(l[key], (JSON.parse(String(saved.ado_sync_base)) as State)[key])) && saved.ado_rev === item.rev && saved.ado_sync_intent === undefined) { await witness(); await invariant(); return; }
    for (const [key, wire] of Object.entries(wireNames)) item.fields[wire] = key === "status" ? ({ open: "New", in_progress: "Active", closed: "Closed", blocked: "Blocked" } as Record<string, string>)[String(l[key])] : key === "tags" ? (l.tags as string[]).join("; ") : l[key];
    item.relations = (l.relations as string[]).map((edge) => { const [rel, id] = JSON.parse(edge) as [string, number]; return { rel, url: `${f.org}/_apis/wit/workItems/${id}` }; });
    item.rev++;
    await witness();
    const result = await f.observed("sync", async () => { await witness(); }, options);
    assert.equal(result.ok, true, JSON.stringify(result));
    await invariant();
  };
  const operations = ["title", "description", "assignee", "priority", "tags", "ado_area_path", "ado_iteration_path", "status", "relations"];
  const counts: Record<string, number> = {}, boundaries = new Set<string>();
  let interrupted = 0, conflicts = 0, successes = 0;
  /** Apply an actor edit through the real SDK or the authoritative fake server, then record its actual value. */
  const edit = async (side: "local" | "remote", key: string, sequence: number): Promise<State[string]> => {
    const value = key === "priority" ? random(5) : key === "tags" ? (random(3) ? [`${side}-${sequence}`] : []) : key === "status" ? ["open", "in_progress", "closed"][random(3)]! : key === "relations" ? random(3) : key === "title" ? `${side} ${sequence}` : random(3) ? `${side} ${sequence}` : "";
    counts[`${side}:${key}`] = (counts[`${side}:${key}`] ?? 0) + 1;
    if (side === "local") {
      if (key === "relations") {
        await f.pm.update(root.id, { unset: ["parent"], depRemove: [...new Set((await readModelItem()).dependencies?.map((edge) => edge.id) ?? [])] });
        if (value !== 0) await f.pm.update(root.id, random(2) ? { parent: peers[Number(value) - 1]!.id } : { dep: [`id=${peers[Number(value) - 1]!.id},kind=related,source_kind=System.LinkTypes.Related`] });
      } else if (key.startsWith("ado_")) await f.setFields(root.id, { [key]: String(value) });
      else await f.pm.update(root.id, key === "status" ? { status: String(value), closeReason: "Reference close", force: true } : key === "tags" ? { tags: JSON.stringify(value) } : key === "assignee" && value === "" ? { unset: ["assignee"] } : { [key]: value });
      return (await local())[key];
    }
    const item = f.items.get(remoteId)!;
    if (key === "relations") item.relations = value === 0 ? [] : [{ rel: random(2) ? "System.LinkTypes.Related" : "System.LinkTypes.Hierarchy-Reverse", url: `${f.org}/_apis/wit/workItems/${byId.get(peers[Number(value) - 1]!.id)}` }];
    else item.fields[wireNames[key]] = key === "status" ? ({ open: "New", in_progress: "Active", closed: "Closed" } as Record<string, string>)[String(value)] : key === "tags" ? (value as string[]).join("; ") : value;
    item.rev++;
    return remote()[key];
  };
  await f.pm.update(root.id, { title: "Reference interrupted scalar" });
  f.items.get(remoteId)!.relations = [{ rel: "System.LinkTypes.Related", url: `${f.org}/_apis/wit/workItems/${byId.get(peers[0]!.id)}` }];
  f.items.get(remoteId)!.rev++;
  let reviewed = false;
  await f.observed("sync", async (event) => {
    await witness(); await invariant();
    if (event.phase === "after" && event.boundary === "remote" && event.operation.startsWith("PATCH")) { reviewed = true; throw new Error("Reviewed interruption"); }
  }, options);
  assert.equal(reviewed, true);
  const recovered = await f.observed("sync", async () => { await witness(); await invariant(); }, options);
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal((remote().relations as string[]).length, 1, "recovery must import, never erase, the remote edit");
  assert.deepEqual(await local(), remote());
  for (let sequence = 0; sequence < 512; sequence++) {
    await resolve();
    const mode = (["import", "export", "sync"] as const)[sequence % 3]!;
    pending = new Map<string, Map<string, State[string]>>();
    /** Keep each actor's latest edit for a key; a typed conflict is the only permitted unresolved result. */
    const actor = async (side: "local" | "remote", key: string) => {
      const before = side === "local" ? await local() : remote();
      await edit(side, key, sequence);
      const after = side === "local" ? await local() : remote();
      for (const changed of Object.keys(before)) if (!same(before[changed], after[changed])) {
        const existing = pending.get(changed) ?? new Map<string, State[string]>();
        existing.set(side, after[changed]); pending.set(changed, existing);
      }
      await witness();
    };
    // Directed commands start with an edit on their source; sync starts with edits on both sides.
    await actor(mode === "import" ? "remote" : "local", operations[sequence % operations.length]!);
    if (mode === "sync") await actor("remote", operations[random(operations.length)]!);
    const l0 = await local(), r0 = remote(), b0 = await base();
    const expectedImports: string[] = [], expectedExports: string[] = [], expectedConflicts: string[] = [];
    for (const key of Object.keys(l0)) {
      if (same(l0[key], r0[key])) continue;
      if (mode === "import") expectedImports.push(key);
      else if (mode === "export") expectedExports.push(key);
      else if (same(l0[key], b0[key])) {
        if (key === "relations" && (l0[key] as string[]).some((edge) => !(r0[key] as string[]).includes(edge))) expectedConflicts.push(key);
        else expectedImports.push(key);
      } else if (same(r0[key], b0[key])) expectedExports.push(key);
      else expectedConflicts.push(key);
    }
    const selectedOptions = mode === "export" ? { limit: 3 } : options;
    const preview = await f.command(mode, { ...selectedOptions, dryRun: true });
    const rootPlan = preview.plans.find((entry) => entry.ado_id === remoteId)!;
    if (expectedConflicts.length) {
      assert.equal(preview.code, "ADO_CONFLICT");
      assert.deepEqual(Object.keys(preview.conflicts[0]!.fields).sort(), expectedConflicts.sort());
    } else {
      assert.ok(preview.ok || mode === "export" && preview.code === "ADO_CONFLICT", JSON.stringify(preview));
      assert.deepEqual(rootPlan.import_fields.sort(), expectedImports.sort());
      assert.deepEqual(rootPlan.export_fields.sort(), expectedExports.sort());
    }
    const target = Math.floor(sequence / 3) % 36;
    let position = 0, hit = false;
    const result = await f.observed(mode, async (event) => {
      await witness();
      await invariant();
      boundaries.add(`${mode}:${event.phase}:${event.boundary}:${event.operation}`);
      if (position++ === target) {
        hit = true; interrupted++;
        // Both actors can edit while the command is suspended, including after an accepted PATCH.
        await actor("local", operations[random(operations.length)]!);
        await actor("remote", operations[random(operations.length)]!);
        throw new Error("Model process interruption");
      }
    }, selectedOptions);
    // An interrupted command cannot report success. Subsequent ordinary sync must preserve or conflict.
    if (hit) assert.equal(result.ok, false);
    const resumed = await f.observed("sync", async () => { await witness(); await invariant(); }, options);
    await invariant();
    assert.ifError(invariantFailure);
    if (resumed.ok) { successes++; assert.deepEqual(await local(), remote(), `success mismatch seed=${seed} sequence=${sequence}`); }
    else { conflicts++; assert.equal(resumed.code, "ADO_CONFLICT", JSON.stringify(resumed)); }
    const l = await local(), r = remote();
    for (const [key, edits] of pending) for (const value of edits.values()) {
      assert.ok(same(l[key], value) || same(r[key], value) || !resumed.ok && (resumed.error !== undefined || resumed.conflicts.some((conflict) => Object.hasOwn(conflict.fields, key))), `lost ${key} edit seed=${seed} sequence=${sequence}: ${JSON.stringify({ value, l, r, result, resumed, pending: [...pending].map(([k,v])=>[k,[...v]]) })}`);
    }
    // Further edits after restart exercise a fresh plan rather than only immediate replay.
    await resolve();
    const k = operations[random(operations.length)]!;
    const retained = await edit(sequence % 2 ? "local" : "remote", k, sequence + 1000);
    await witness();
    const further = await f.observed("sync", async () => { await witness(); await invariant(); }, options);
    assert.ok(further.ok || further.code === "ADO_CONFLICT", JSON.stringify(further));
    if (further.ok) assert.deepEqual(await local(), remote());
    assert.ok(same((await local())[k], retained) || same(remote()[k], retained) || !further.ok);
    assert.equal(f.items.size, 3, "model must never create a duplicate object");
    if ((sequence + 1) % 64 === 0) t.diagnostic(`two-sided model completed ${sequence + 1}/512 sequences`);
  }
  assert.ok(interrupted >= 200);
  assert.ok(successes > 0 && conflicts > 0);
  for (const side of ["local", "remote"]) for (const key of operations) assert.ok(counts[`${side}:${key}`], `${side} ${key} missing`);
  t.diagnostic(JSON.stringify({ sequences: 512, seed: "0x37a9c521", interrupted, successes, conflicts, boundaries: [...boundaries].sort(), actor_operations: counts }));
});

test("round-3 fixed: interrupted scalar PATCH never promotes an unimported remote relation", async (t) => {
  const f = await fixture(t, [workItem(1), workItem(2)]);
  assert.equal((await f.command("import")).ok, true);
  const rows = (await f.pm.listAllComplete()).items;
  const root = rows.find((item) => item.ado_id === 1)!, peer = rows.find((item) => item.ado_id === 2)!;
  await f.pm.update(root.id, { title: "Local scalar edit" });
  f.items.get(1)!.relations = [{ rel: "System.LinkTypes.Related", url: `${f.org}/_apis/wit/workItems/2` }];
  f.items.get(1)!.rev++;
  let hit = false;
  await f.observed("sync", (event) => {
    if (event.boundary === "remote" && event.phase === "after" && event.operation.startsWith("PATCH")) { hit = true; throw new Error("Lost response after scalar acceptance"); }
  }, { limit: 1 });
  assert.equal(hit, true);
  assert.deepEqual(JSON.parse(String((await f.pm.get(root.id)).item.ado_sync_base)).relations, []);
  const result = await f.command("sync", { limit: 1 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.items.get(1)!.fields["System.Title"], "Local scalar edit");
  assert.equal(f.items.get(1)!.relations!.length, 1);
  assert.ok((await f.pm.get(root.id)).item.dependencies!.some((edge) => edge.id === peer.id));
});

test("round-3 read-back fences refuse missing and older Azure state without advancing agreement", async (t) => {
  for (const outcome of ["missing", "older"] as const) await t.test(outcome, async (sub) => {
    const f = await fixture(sub);
    assert.equal((await f.command("import")).ok, true);
    const item = await row(f.pm), originalBase = item.ado_sync_base;
    f.items.get(1)!.fields["System.Title"] = "New remote title"; f.items.get(1)!.rev++;
    let batches = 0;
    f.afterBatch(async () => {
      if (++batches === 1) f.response("workitemsbatch", { value: outcome === "missing" ? [] : [workItem(1)] });
    });
    const result = await f.command("import");
    assert.equal(result.code, "ADO_CONFLICT", JSON.stringify(result));
    const kept = (await f.pm.get(item.id)).item;
    assert.equal(kept.title, "New remote title");
    assert.equal(kept.ado_sync_base, originalBase);
    assert.equal(kept.ado_rev, 1);
  });
  const f = await fixture(t, [workItem(1), workItem(2)]);
  const config = { orgUrl: f.org, project: "Project", token: "synthetic-token" };
  assert.equal((await f.command("import")).ok, true);
  await assert.rejects(readLocalAgreement(f.pm, "fixture-missing", config), /disappeared/u);
  const rows = (await f.pm.listAllComplete()).items, root = rows[0]!, peer = rows[1]!;
  assert.equal((await readLocalAgreement(f.pm, root.id, config)).identities.size, 2);
  await f.setFields(peer.id, { ado_org_url: "https://dev.azure.com/other" });
  assert.equal((await readLocalAgreement(f.pm, root.id, config)).identities.size, 1);
  await f.setFields(peer.id, { ado_org_url: f.org, ado_id: 1.5 });
  assert.equal((await readLocalAgreement(f.pm, root.id, config)).identities.size, 1);
  await f.setFields(root.id, { ado_project: "Other" });
  await assert.rejects(readLocalAgreement(f.pm, root.id, config, root.updated_at), { exitCode: 4 });
});

test("round-3 SDK validation refusal preserves synced data and its agreed base", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.command("import")).ok, true);
  const before = (await row(f.pm));
  const history = readFileSync(join(f.pmRoot, "history", `${before.id}.jsonl`), "utf8");
  f.items.get(1)!.fields["System.Title"] = ""; f.items.get(1)!.rev++;
  const result = await f.command("import");
  assert.equal(result.code, "ADO_REMOTE", JSON.stringify(result));
  const after = await row(f.pm);
  assert.ok(after.ado_sync_intent, "failed apply keeps its durable integration intent");
  const unchanged = (value: typeof before) => Object.fromEntries(Object.entries(value).filter(([key]) => !["updated_at", "ado_sync_intent"].includes(key)));
  assert.deepEqual(unchanged(after), unchanged(before));
  assert.ok(readFileSync(join(f.pmRoot, "history", `${before.id}.jsonl`), "utf8").startsWith(history));
});

test("round-3 scalar resolution acknowledges only agreed keys and leaves remote links for sync", async (t) => {
  const f = await fixture(t, [workItem(1), workItem(2)]);
  assert.equal((await f.command("import")).ok, true);
  const rows = (await f.pm.listAllComplete()).items;
  const root = rows.find((item) => item.ado_id === 1)!, peer = rows.find((item) => item.ado_id === 2)!;
  await f.pm.update(root.id, { title: "Resolved local scalar" });
  f.items.get(1)!.relations = [{ rel: "System.LinkTypes.Related", url: `${f.org}/_apis/wit/workItems/2` }];
  f.items.get(1)!.rev++;
  const service = resolver(f), plan = choices(await service.plan(root.id));
  await assert.rejects(service.apply(plan), { code: "ado_partial_apply" });
  const partial = (await f.pm.get(root.id)).item, base = JSON.parse(String(partial.ado_sync_base));
  assert.equal(base.title, "Resolved local scalar");
  assert.deepEqual(base.relations, []);
  assert.equal(partial.ado_rev, 1);
  assert.equal(f.items.get(1)!.relations!.length, 1);
  assert.equal((await f.command("sync", { limit: 1 })).ok, true);
  assert.ok((await f.pm.get(root.id)).item.dependencies!.some((edge) => edge.id === peer.id));
  assert.equal((await service.apply(plan)).replayed, true);
  assert.equal(f.requests.filter((request) => request.method === "PATCH").length, 1);
});

test("round-3 local scalar reversion during partial import remains a conflict after restart", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.command("import")).ok, true);
  const item = await row(f.pm), original = item.title;
  f.items.get(1)!.fields["System.Title"] = "New remote scalar"; f.items.get(1)!.rev++;
  let hit = false;
  const interrupted = await f.observed("import", async (event) => {
    if (!hit && event.boundary === "local" && event.phase === "after" && event.operation === "update") {
      hit = true; await f.pm.update(item.id, { title: original });
    }
  });
  assert.equal(hit, true); assert.equal(interrupted.code, "ADO_CONFLICT");
  const resumed = await f.command("sync");
  assert.equal(resumed.code, "ADO_CONFLICT");
  assert.ok(resumed.conflicts[0]!.fields.title);
  assert.equal((await f.pm.get(item.id)).item.title, original);
  assert.equal(f.items.get(1)!.fields["System.Title"], "New remote scalar");
  const service = resolver(f), plan = choices(await service.plan(item.id));
  assert.equal((await service.apply(plan)).ok, true);
  assert.equal((await f.pm.get(item.id)).item.ado_sync_intent, undefined);
  assert.equal((await f.command("sync")).ok, true);
});

test("guarded SDK commands name a removed module link while bound read-only refresh works", async (t) => {
  const f = await fixture(t);
  const { item } = await f.pm.create({ title: "Read-only linked seed", type: "Task" });
  await f.setFields(item.id, { ado_id: 1, ado_rev: 1, ado_project: "Project", ado_org_url: f.org });
  rmSync(join(f.root, "node_modules/@unbrained/pm-cli"));
  const before = snapshot(f.pmRoot);
  const sourceRefusal = await f.observed("import", () => {}, {}, [join(f.root, "package.json")]);
  assert.equal(sourceRefusal.code, "ADO_USAGE");
  assert.match(sourceRefusal.error!, /host links its SDK/u);
  for (const mode of ["import", "export", "sync"]) {
    const result = await f.host(["ado", mode, "--json"], { GIT_CEILING_DIRECTORIES: tmpdir(), PATH: f.pmRoot });
    assert.equal(result.code, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /ADO_USAGE[\s\S]*host links its SDK/u);
  }
  assert.deepEqual(snapshot(f.pmRoot), before);
  const refresh = await f.host(["ado", "refresh-plan", "--fields", "title,status,relations", "--json"], { GIT_CEILING_DIRECTORIES: tmpdir(), PATH: f.pmRoot });
  assert.equal(refresh.code, 0, refresh.stdout + refresh.stderr);
  assert.deepEqual(snapshot(f.pmRoot), before);
});

test("local sync recovery rejects malformed or foreign-edited intents without overwriting tracker data", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.command("import")).ok, true);
  const item = await row(f.pm);
  f.items.get(1)!.fields["System.Title"] = "Awaiting local apply"; f.items.get(1)!.rev++;
  let hit = false;
  await f.observed("import", (event) => {
    if (event.boundary === "local" && event.phase === "after" && event.operation === "local-prepared") { hit = true; throw new Error("Stop after durable plan"); }
  });
  assert.equal(hit, true);
  const original = String((await f.pm.get(item.id)).item.ado_sync_intent);
  const plan = JSON.parse(original) as Record<string, unknown>;
  const missingProof: Record<string, unknown> = { ...plan, version: "different-inspected-revision" };
  missingProof.plan = resolutionDigest([plan.scope, item.id, missingProof.version]);
  const invalid = ["{", "null", "[]", ...[{ ...plan, schema: "invalid" }, { ...plan, scope: "wrong" }, { ...plan, version: 7 }, { ...plan, plan: "wrong" },
    { ...plan, wanted: null }, { ...plan, wanted: 7 }, { ...plan, wanted: [] }, { ...plan, seen: null }, { ...plan, seen: 7 }, { ...plan, seen: [] },
    { ...plan, remote: null }, { ...plan, remote: 7 }, { ...plan, remote: { id: 0, revision: 1 } }, { ...plan, remote: { id: 1.5, revision: 1 } }, { ...plan, remote: { id: 99, revision: 1 } }, { ...plan, remote: { id: 1, revision: 0 } }, { ...plan, remote: { id: 1, revision: 1.5 } }, { ...plan, close: null }, { ...plan, close: 7 },
    { ...plan, close: { status: 7, assignee: "", transaction: "invalid" } }, { ...plan, close: { status: "closed", assignee: 7, transaction: "invalid" } },
    { ...plan, close: { status: "closed", assignee: "", transaction: "invalid" } }, missingProof].map((value) => JSON.stringify(value)), original];
  for (const value of invalid) {
    await f.setFields(item.id, { ado_sync_intent: value });
    const before = snapshot(f.pmRoot);
    const result = await f.command("sync");
    assert.equal(result.code, "ADO_CONFLICT", JSON.stringify(result));
    assert.deepEqual(snapshot(f.pmRoot), before);
  }
});

test("native close recovery finishes assignment before any export can reverse it", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.command("import")).ok, true);
  const item = await row(f.pm), intended = f.items.get(1)!.fields["System.AssignedTo"];
  f.items.get(1)!.fields["System.State"] = "Closed"; f.items.get(1)!.rev++;
  let hit = false;
  await f.observed("import", (event) => {
    if (event.boundary === "local" && event.phase === "after" && event.operation === "close") { hit = true; throw new Error("Native close durable, assignment not finished"); }
  });
  assert.equal(hit, true);
  assert.equal((await f.pm.get(item.id)).item.assignee, undefined);
  const dry = await f.command("sync", { dryRun: true });
  assert.equal(dry.code, "ADO_CONFLICT");
  const result = await f.command("sync");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((await f.pm.get(item.id)).item.assignee, "fixture@example.invalid");
  assert.deepEqual(f.items.get(1)!.fields["System.AssignedTo"], intended);
  assert.equal((await f.pm.get(item.id)).item.ado_sync_intent, undefined);
  assert.ok(f.requests.every((request) => request.method !== "PATCH"));
});

test("inverse local relation writes retain an intent until that item's own read-back agrees", async (t) => {
  const f = await fixture(t, [workItem(1), workItem(2)]);
  assert.equal((await f.command("import")).ok, true);
  const rows = (await f.pm.listAllComplete()).items;
  const root = rows.find((item) => item.ado_id === 1)!, child = rows.find((item) => item.ado_id === 2)!;
  await f.setFields(child.id, {}, ["ado_rev"]);
  f.items.get(1)!.relations = [{ rel: "System.LinkTypes.Hierarchy-Forward", url: `${f.org}/_apis/wit/workItems/2` }]; f.items.get(1)!.rev++;
  const imported = await f.command("import", { limit: 1 });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  const pending = (await f.pm.get(child.id)).item;
  assert.equal(pending.parent, root.id);
  assert.ok(pending.ado_sync_intent);
  assert.equal(pending.ado_rev, undefined);
  assert.deepEqual(JSON.parse(String(pending.ado_sync_base)).relations, []);
  // Observe Azure's inverse endpoint before acknowledging that endpoint's state.
  f.items.get(2)!.relations = [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: `${f.org}/_apis/wit/workItems/1` }]; f.items.get(2)!.rev++;
  assert.equal((await f.command("sync")).ok, true);
  assert.equal((await f.pm.get(child.id)).item.ado_sync_intent, undefined);
});

test("remote reversions after a partial local import propagate or conflict without an Azure reversal", async (t) => {
  for (const key of ["title", "relations"] as const) await t.test(key, async (sub) => {
    const f = await fixture(sub, [workItem(1), workItem(2)]);
    assert.equal((await f.command("import")).ok, true);
    const item = (await f.pm.listAllComplete()).items.find((row) => row.ado_id === 1)!;
    if (key === "title") f.items.get(1)!.fields["System.Title"] = "Remote transient title";
    else f.items.get(1)!.relations = [{ rel: "System.LinkTypes.Related", url: `${f.org}/_apis/wit/workItems/2` }];
    f.items.get(1)!.rev++;
    let hit = false;
    const partial = await f.observed("import", (event) => {
      if (!hit && event.boundary === "local" && event.phase === "after" && event.operation === "update") {
        hit = true;
        if (key === "title") f.items.get(1)!.fields["System.Title"] = item.title;
        else f.items.get(1)!.relations = [];
        f.items.get(1)!.rev++;
      }
    }, { limit: 1 });
    assert.equal(hit, true); assert.equal(partial.code, "ADO_CONFLICT");
    const resumed = await f.command("sync", { limit: 1 });
    if (key === "title") {
      assert.equal(resumed.ok, true, JSON.stringify(resumed));
      assert.equal((await f.pm.get(item.id)).item.title, item.title);
    } else assert.equal(resumed.code, "ADO_CONFLICT");
    assert.equal(f.items.get(1)!.fields["System.Title"], item.title);
    assert.deepEqual(f.items.get(1)!.relations, []);
    assert.ok(f.requests.every((request) => request.method !== "PATCH"));
  });
});

test("durable local intent refuses an older Azure replay after interruption", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.command("import")).ok, true);
  const item = await row(f.pm), older = structuredClone(f.items.get(1)!);
  f.items.get(1)!.fields["System.Title"] = "Newer observed state"; f.items.get(1)!.rev++;
  await f.observed("import", (event) => {
    if (event.boundary === "local" && event.phase === "after" && event.operation === "update") throw new Error("After local import before agreement");
  });
  assert.equal((await f.pm.get(item.id)).item.title, "Newer observed state");
  f.items.set(1, older);
  const before = snapshot(f.pmRoot);
  assert.equal((await f.command("sync")).code, "ADO_CONFLICT");
  assert.deepEqual(snapshot(f.pmRoot), before);
});


test("resolution refuses stale per-key agreement without an acknowledged item revision", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.command("import")).ok, true);
  const item = await row(f.pm);
  f.items.get(1)!.rev = 2;
  f.items.get(1)!.fields["System.Title"] = "Witnessed newer title";
  assert.equal((await f.command("import")).ok, true);
  await f.setFields(item.id, {}, ["ado_rev"]);
  assert.equal((await resolver(f).plan(item.id)).remote.revision, 2);
  f.items.get(1)!.rev = 1;
  const before = snapshot(f.pmRoot);
  await assert.rejects(resolver(f).plan(item.id), { code: "stale_remote" });
  assert.deepEqual(snapshot(f.pmRoot), before);
  assert.ok(f.requests.every((request) => request.method !== "PATCH"));
});


test("unassigned terminal imports resume an interrupted close without inventing an assignment", async (t) => {
  const f = await fixture(t, [workItem(1, { "System.AssignedTo": "" })]);
  assert.equal((await f.command("import")).ok, true);
  const item = await row(f.pm);
  f.items.get(1)!.fields["System.State"] = "Closed";
  f.items.get(1)!.rev++;
  let interrupted = false;
  await f.observed("import", (event) => {
    if (event.boundary === "local" && event.operation === "close" && event.phase === "after") {
      interrupted = true; throw new Error("Close completed before agreement");
    }
  });
  assert.equal(interrupted, true);
  assert.equal((await f.pm.get(item.id)).item.assignee, undefined);
  assert.equal(JSON.parse(String((await f.pm.get(item.id)).item.ado_sync_base)).status, "open");
  assert.equal((await f.command("sync")).ok, true);
  const settled = (await f.pm.get(item.id)).item;
  assert.equal(settled.status, "closed");
  assert.equal(settled.assignee, undefined);
  assert.equal(settled.ado_sync_intent, undefined);
  assert.equal(JSON.parse(String(settled.ado_sync_base)).status, "closed");
  assert.ok(f.requests.every((request) => request.method !== "PATCH"));
});


test("creation recovery removes a server-default relation absent from the explicit export", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.command("import")).ok, true);
  const created = await f.pm.create({ title: "Explicit export without links", type: "Task" });
  f.afterCreate(async () => {
    f.items.get(2)!.relations = [{ rel: "System.LinkTypes.Related", url: `${f.org}/_apis/wit/workItems/1` }];
  });
  const result = await f.command("export");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((await f.pm.get(created.item.id)).item.ado_id, 2);
  assert.deepEqual(f.items.get(2)!.relations, []);
  assert.ok(f.requests.some((request) => request.method === "PATCH" && (request.body as JsonPatchOperation[]).some((operation) => operation.op === "remove" && operation.path === "/relations/0")));
  const writes = f.requests.filter((request) => request.method === "PATCH" || request.path.includes("/workitems/$")).length;
  assert.equal((await f.command("sync")).ok, true);
  assert.equal(f.requests.filter((request) => request.method === "PATCH" || request.path.includes("/workitems/$")).length, writes);
});

test("pending inverse endpoint refuses unagreed local relation ownership until Azure read-back matches", async (t) => {
  const f = await fixture(t, [workItem(1), workItem(2)]);
  assert.equal((await f.command("import")).ok, true);
  const rows = (await f.pm.listAllComplete()).items;
  const root = rows.find((item) => item.ado_id === 1)!, child = rows.find((item) => item.ado_id === 2)!;
  f.items.get(1)!.relations = [{ rel: "System.LinkTypes.Hierarchy-Forward", url: `${f.org}/_apis/wit/workItems/2` }];
  f.items.get(1)!.rev++;
  assert.equal((await f.command("import", { limit: 1 })).ok, true);
  assert.equal((await f.pm.get(child.id)).item.parent, root.id);
  assert.ok((await f.pm.get(child.id)).item.ado_sync_intent);
  f.response("wiql", { workItems: [{ id: 2 }] });
  const before = snapshot(f.pmRoot);
  const resumed = await f.command("sync");
  assert.equal(resumed.code, "ADO_CONFLICT", JSON.stringify(resumed));
  assert.ok(resumed.conflicts[0]!.fields.relations);
  assert.deepEqual(snapshot(f.pmRoot), before);
  assert.deepEqual(f.items.get(2)!.relations, []);
  assert.ok(f.requests.every((request) => request.method !== "PATCH"));
  f.items.get(2)!.relations = [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: `${f.org}/_apis/wit/workItems/1` }];
  f.items.get(2)!.rev++;
  assert.equal((await f.command("sync")).ok, true);
  assert.equal((await f.pm.get(child.id)).item.ado_sync_intent, undefined);
});

test("round-4 graph ownership covers every affected endpoint regardless of selection or direction", async (t) => {
  for (const relation of ["System.LinkTypes.Hierarchy-Forward", "System.LinkTypes.Hierarchy-Reverse"]) {
    for (const edit of ["clear", "retarget", "dependency-and-clear"] as const) await t.test(`${relation}:${edit}`, async (sub) => {
      const f = await fixture(sub, [workItem(1), workItem(2), workItem(3)]);
      assert.equal((await f.command("import")).ok, true);
      const rows = (await f.pm.listAllComplete()).items;
      const childRemote = relation.endsWith("Forward") ? 2 : 1;
      const parentRemote = childRemote === 2 ? 1 : 2;
      const child = rows.find((item) => item.ado_id === childRemote)!, parent = rows.find((item) => item.ado_id === parentRemote)!;
      const peer = rows.find((item) => item.ado_id === 3)!;
      f.items.get(1)!.relations = [{ rel: relation, url: `${f.org}/_apis/wit/workItems/2` }]; f.items.get(1)!.rev++;
      let interrupted = false;
      await f.observed("import", (event) => {
        if (event.boundary === "local" && event.phase === "after" && event.operation === "update" && event.item === child.id) {
          interrupted = true; throw new Error("Stop after imported graph endpoint");
        }
      }, { limit: 1 });
      assert.equal(interrupted, true);
      assert.equal((await f.pm.get(child.id)).item.parent, parent.id);
      await f.pm.update(child.id, edit === "retarget" ? { parent: peer.id } : {
        unset: ["parent"], ...(edit === "dependency-and-clear" ? { dep: [`id=${peer.id},kind=related`] } : {}),
      });
      const before = snapshot(f.pmRoot);
      for (const dryRun of [false, true]) {
        const result = await f.command("sync", { limit: 1, dryRun });
        assert.equal((await f.pm.get(child.id)).item.parent, edit === "retarget" ? peer.id : undefined, "the latest endpoint edit must survive an actual sync retry");
        assert.equal(result.code, "ADO_CONFLICT", JSON.stringify(result));
        assert.deepEqual(snapshot(f.pmRoot), before, "selection cannot authorize overwriting an endpoint edit");
      }
      if (relation.endsWith("Forward") && edit === "clear") {
        for (const format of ["json", "toon"]) {
          const result = await f.host(["ado", "sync", "--limit", "1", "--output-format", format]);
          assert.equal(result.code, 4, result.stdout + result.stderr);
          assert.match(result.stdout, /ADO_CONFLICT/u);
          assert.deepEqual(snapshot(f.pmRoot), before);
        }
      }
      assert.ok(f.requests.every((request) => request.method !== "PATCH" && !request.path.includes("/workitems/$")));
    });
  }
});

test("round-4 first-import partial bases produce portable JSON and TOON resolution choices and apply", async (t) => {
  const f = await fixture(t);
  let changed = false;
  const result = await f.observed("import", (event) => {
    if (!changed && event.boundary === "local" && event.phase === "after" && event.operation === "create") {
      changed = true; f.items.get(1)!.fields["System.Title"] = "Concurrent remote title"; f.items.get(1)!.rev++;
    }
  });
  assert.equal(changed, true); assert.equal(result.code, "ADO_CONFLICT");
  const item = await row(f.pm), base = JSON.parse(String(item.ado_sync_base));
  assert.equal(base.ado_base_partial, 1); assert.equal(Object.hasOwn(base, "title"), false);
  const plan = choices(await resolver(f).plan(item.id), "remote");
  assert.equal(plan.fields.find((field) => field.field === "title")!.base, null);
  assert.equal(plan.fields.find((field) => field.field === "title")!.conflict, true);
  validateResolutionPlan(JSON.parse(JSON.stringify(plan)));
  const before = snapshot(f.pmRoot);
  const json = await f.host(["ado", "resolve-plan", "--item", item.id, "--json"]);
  assert.equal(json.code, 0, json.stdout + json.stderr);
  const portable = (JSON.parse(json.stdout) as { plan: ResolutionPlan }).plan;
  assert.equal(portable.fields.find((field) => field.field === "title")!.base, null);
  const toon = await f.host(["ado", "resolve-plan", "--item", item.id, "--output-format", "toon"]);
  assert.equal(toon.code, 0, toon.stdout + toon.stderr); assert.match(toon.stdout, /title,null,/u);
  assert.deepEqual(snapshot(f.pmRoot), before, "planning is read-only for partial as well as complete bases");
  const saved = await f.host(["ado", "resolve-plan", "--item", item.id, "--save", "--json"]);
  assert.equal(saved.code, 0, saved.stdout + saved.stderr);
  const planId = (JSON.parse(saved.stdout) as { plan_id: string }).plan_id;
  await f.pm.update(planId, { body: JSON.stringify(plan) });
  const applied = await f.host(["ado", "resolve-apply", "--plan", planId, "--json"]);
  assert.equal(applied.code, 0, applied.stdout + applied.stderr);
  assert.equal((await f.pm.get(item.id)).item.title, "Concurrent remote title");
  assert.equal((await resolver(f).apply(plan)).replayed, true);
  assert.equal((await f.command("sync")).ok, true);
});

test("round-4 all partial-base masks retain unknown coordinates across resolution projection and validation", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.command("import")).ok, true);
  const item = await row(f.pm), local: ReturnType<typeof localValues> = { ...localValues(item), relations: [] }, keys = Object.keys(local);
  const remote = workItem(1, { "System.Title": "Changed title", "System.Description": "Changed details", "System.State": "Active",
    "Microsoft.VSTS.Common.Priority": 3, "System.Tags": "different", "System.AssignedTo": "other@example.invalid", "System.AreaPath": "Project\\Other", "System.IterationPath": "Project\\Other" }, 2);
  const maps = { imports: IMPORT_STATE_MAP, exports: STATE_MAP }, template = await resolver(f).plan(item.id);
  for (let mask = 0; mask < 2 ** keys.length; mask++) {
    const known = Object.fromEntries(keys.filter((_key, index) => (mask & 2 ** index) !== 0).map((key) => [key, local[key]]));
    const projected = resolutionFields({ ...item, ado_sync_base: JSON.stringify({ ...known, ado_base_partial: 1 }) }, remote, maps);
    for (const field of projected) {
      assert.equal(field.base, Object.hasOwn(known, field.field) ? resolutionDigest(local[field.field]) : null, `mask ${mask}: ${field.field}`);
      assert.equal(field.conflict, !Object.hasOwn(known, field.field), `mask ${mask}: unknown ancestry remains a conflict`);
    }
    const plan: ResolutionPlan = { ...template, fields: projected,
      remote: { id: 1, revision: 2, digest: resolutionDigest(remote) },
      choices: projected.filter((field) => field.local !== field.remote).map(({ field }) => ({ field, take: "remote" })) };
    validateResolutionPlan(JSON.parse(JSON.stringify(plan)));
  }
  t.diagnostic(`${2 ** keys.length} partial-base masks cover every synced scalar and mixed known/unknown ancestry`);
});


test("round-4 agreed graph endpoints retain local edits even without a pending integration intent", async (t) => {
  for (const edit of ["clear", "retarget", "dependency-remove"] as const) await t.test(edit, async (sub) => {
    const f = await fixture(sub, [1, 2, 3, 4].map((id) => workItem(id)));
    f.items.get(1)!.relations = [{ rel: "System.LinkTypes.Hierarchy-Forward", url: `${f.org}/_apis/wit/workItems/2` }];
    f.items.get(2)!.relations = [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: `${f.org}/_apis/wit/workItems/1` },
      { rel: "System.LinkTypes.Related", url: `${f.org}/_apis/wit/workItems/4` }];
    f.items.get(4)!.relations = [{ rel: "System.LinkTypes.Related", url: `${f.org}/_apis/wit/workItems/2` }];
    assert.equal((await f.command("import")).ok, true);
    const rows = (await f.pm.listAllComplete()).items;
    const child = rows.find((item) => item.ado_id === 2)!, peer = rows.find((item) => item.ado_id === 4)!;
    assert.equal(child.ado_sync_intent, undefined);
    await f.pm.update(child.id, edit === "retarget" ? { parent: peer.id } : edit === "dependency-remove" ? { depRemove: [peer.id] } : { unset: ["parent"] });
    // A symmetric related edge is gone only after both stored directions are removed.
    if (edit === "dependency-remove") await f.pm.update(peer.id, { depRemove: [child.id] });
    f.items.get(1)!.relations = []; f.items.get(1)!.rev++;
    f.items.get(2)!.relations = [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: `${f.org}/_apis/wit/workItems/3` },
      { rel: "System.LinkTypes.Related", url: `${f.org}/_apis/wit/workItems/4` }]; f.items.get(2)!.rev++;
    f.items.get(3)!.relations = [{ rel: "System.LinkTypes.Hierarchy-Forward", url: `${f.org}/_apis/wit/workItems/2` }]; f.items.get(3)!.rev++;
    f.response("wiql", { workItems: [{ id: 3 }] });
    const before = snapshot(f.pmRoot);
    for (const dryRun of [false, true]) {
      const result = await f.command("sync", { limit: 1, dryRun });
      assert.equal(result.code, "ADO_CONFLICT", JSON.stringify(result));
      assert.deepEqual(snapshot(f.pmRoot), before);
    }
    assert.ok(f.requests.every((request) => request.method !== "PATCH"));
  });
});


test("round-4 prospective remote sources must authorize existing endpoints before local creation", async (t) => {
  const f = await fixture(t, [workItem(1), workItem(2)]);
  f.items.get(1)!.relations = [{ rel: "System.LinkTypes.Hierarchy-Forward", url: `${f.org}/_apis/wit/workItems/2` }];
  f.items.get(2)!.relations = [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: `${f.org}/_apis/wit/workItems/1` }];
  assert.equal((await f.command("import")).ok, true);
  const child = (await f.pm.listAllComplete()).items.find((item) => item.ado_id === 2)!;
  await f.pm.update(child.id, { unset: ["parent"] });
  f.items.get(1)!.relations = []; f.items.get(1)!.rev++;
  f.items.get(2)!.relations = [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: `${f.org}/_apis/wit/workItems/4` }]; f.items.get(2)!.rev++;
  f.items.set(4, { ...workItem(4), relations: [{ rel: "System.LinkTypes.Hierarchy-Forward", url: `${f.org}/_apis/wit/workItems/2` }] });
  f.response("wiql", { workItems: [{ id: 4 }] });
  const before = snapshot(f.pmRoot);
  for (const dryRun of [false, true]) {
    assert.equal((await f.command("sync", { limit: 1, dryRun })).code, "ADO_CONFLICT");
    assert.deepEqual(snapshot(f.pmRoot), before, "known endpoint conflicts precede even native creation of a new source");
  }
  assert.equal((await f.pm.listAllComplete()).items.length, 2);
  assert.ok(f.requests.every((request) => request.method !== "PATCH"));
});

test("round-4 prospective graph identities never reach native SDK persistence", async (t) => {
  const f = await fixture(t, [workItem(1), workItem(2)]);
  f.items.get(1)!.relations = [{ rel: "System.LinkTypes.Hierarchy-Forward", url: `${f.org}/_apis/wit/workItems/2` }];
  f.items.get(2)!.relations = [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: `${f.org}/_apis/wit/workItems/1` }];
  const result = await f.command("sync");
  assert.equal(result.ok, true, JSON.stringify(result));
  const rows = (await f.pm.listAllComplete()).items;
  assert.equal(rows.length, 2);
  const parent = rows.find((item) => item.ado_id === 1)!, child = rows.find((item) => item.ado_id === 2)!;
  assert.equal(child.parent, parent.id);
  assert.ok(rows.every((item) => item.ado_sync_intent === undefined));
  assert.equal(JSON.stringify(rows).includes("ado-unlinked:"), false);
  const before = snapshot(f.pmRoot);
  assert.equal((await f.command("sync")).ok, true);
  assert.deepEqual(snapshot(f.pmRoot), before);
  assert.ok(f.requests.every((request) => request.method !== "PATCH" && !request.path.includes("/workitems/$")));
});

test("round-4 closed unassigned items can apply reviewed partial-base choices", async (t) => {
  const f = await fixture(t, [workItem(1, { "System.State": "Closed", "System.AssignedTo": "" })]);
  assert.equal((await f.command("import")).ok, true);
  const item = await row(f.pm);
  await f.setFields(item.id, { ado_sync_base: JSON.stringify({ ado_base_partial: 1, relations: [] }) });
  f.items.get(1)!.fields["System.Title"] = "Reviewed closed title"; f.items.get(1)!.rev++;
  const service = resolver(f), plan = choices(await service.plan(item.id), "remote");
  assert.equal((await service.apply(plan)).ok, true);
  assert.equal((await f.pm.get(item.id)).item.title, "Reviewed closed title");
  const settled = (await f.pm.get(item.id)).item;
  assert.equal(settled.status, "closed");
  assert.equal(settled.closed_at, item.closed_at);
  assert.equal(settled.completed_at, item.completed_at);
  assert.equal(settled.close_reason, item.close_reason);
  assert.equal((await service.apply(plan)).replayed, true);
});


test("round-4 SDK storage refusal preserves project links and returns actionable configuration without writes", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.command("import")).ok, true);
  const item = await row(f.pm);
  f.items.get(1)!.fields["System.Title"] = "Reviewed value"; f.items.get(1)!.rev++;
  const service = resolver(f), plan = choices(await service.plan(item.id), "remote");
  const scope = join(f.pmRoot, "extensions/pm-ado/node_modules/@unbrained"); mkdirSync(scope, { recursive: true });
  const link = join(scope, "pm-cli"); symlinkSync(join(repo, "node_modules/@unbrained/pm-cli"), link, "junction");
  const before = snapshot(f.pmRoot);
  await assert.rejects(service.apply(plan), (error: unknown) => error instanceof ResolutionRefusal && error.code === "configuration" && error.remedy.includes("global pm-ado installation"));
  assert.deepEqual(snapshot(f.pmRoot), before);
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal((await f.pm.get(item.id)).item.ado_resolution_intent, undefined);
  assert.ok(f.requests.every((request) => request.method !== "PATCH"));
});

test("round-4 canonical status aliases preserve native close semantics during import", async (t) => {
  for (const initial of ["New", "Closed"]) await t.test(initial, async (sub) => {
    const f = await fixture(sub, [workItem(1, { "System.State": initial, "System.AssignedTo": "" })]);
    assert.equal((await f.command("import")).ok, true);
    const item = await row(f.pm);
    f.env.ADO_STATUS_MAP = JSON.stringify({ ...IMPORT_STATE_MAP, Closed: "CLOSED" });
    f.items.get(1)!.fields["System.State"] = "Closed"; f.items.get(1)!.fields["System.Title"] = "Canonical imported title"; f.items.get(1)!.rev++;
    const imported = await f.command("import");
    assert.equal(imported.ok, true, JSON.stringify(imported));
    const after = (await f.pm.get(item.id)).item;
    assert.equal(after.status, "closed"); assert.equal(after.title, "Canonical imported title");
    assert.equal(typeof after.closed_at, "string");
    if (initial === "Closed") { assert.equal(after.closed_at, item.closed_at); assert.equal(after.close_reason, item.close_reason); }
  });
});

test("round-4 canonical status aliases preserve native close semantics during partial resolution", async (t) => {
  for (const initial of ["New", "Closed"]) await t.test(initial, async (sub) => {
    const f = await fixture(sub, [workItem(1, { "System.State": initial, "System.AssignedTo": "" })]);
    assert.equal((await f.command("import")).ok, true);
    const item = await row(f.pm);
    await f.setFields(item.id, { ado_sync_base: JSON.stringify({ ado_base_partial: 1, relations: [] }) });
    f.items.get(1)!.fields["System.State"] = "Closed"; f.items.get(1)!.fields["System.Title"] = "Canonical resolved title"; f.items.get(1)!.rev++;
    const before = process.env.ADO_STATUS_MAP;
    process.env.ADO_STATUS_MAP = JSON.stringify({ ...IMPORT_STATE_MAP, Closed: "CLOSED" });
    try {
      const service = resolver(f), plan = choices(await service.plan(item.id), "remote");
      assert.equal((await service.apply(plan)).ok, true);
      const after = (await f.pm.get(item.id)).item;
      assert.equal(after.status, "closed"); assert.equal(after.title, "Canonical resolved title");
      assert.equal(typeof after.closed_at, "string");
      if (initial === "Closed") { assert.equal(after.closed_at, item.closed_at); assert.equal(after.close_reason, item.close_reason); }
      assert.equal((await service.apply(plan)).replayed, true);
    } finally { if (before === undefined) delete process.env.ADO_STATUS_MAP; else process.env.ADO_STATUS_MAP = before; }
  });
});


test("round-4 canonical status aliases survive an interrupted close and resume", async (t) => {
  const f = await fixture(t, [workItem(1, { "System.AssignedTo": "" })]);
  assert.equal((await f.command("import")).ok, true);
  const item = await row(f.pm);
  f.env.ADO_STATUS_MAP = JSON.stringify({ ...IMPORT_STATE_MAP, Closed: "CLOSED" });
  f.items.get(1)!.fields["System.State"] = "Closed"; f.items.get(1)!.fields["System.Title"] = "Interrupted canonical close"; f.items.get(1)!.rev++;
  let hit = false;
  await f.observed("import", (event) => {
    if (!hit && event.boundary === "local" && event.phase === "after" && event.operation === "update") {
      hit = true; throw new Error("Interrupted before native close");
    }
  });
  assert.equal(hit, true);
  assert.ok((await f.pm.get(item.id)).item.ado_sync_intent);
  const resumed = await f.command("sync");
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  const settled = (await f.pm.get(item.id)).item;
  assert.equal(settled.status, "closed"); assert.equal(typeof settled.closed_at, "string");
  assert.equal(settled.ado_sync_intent, undefined);
  assert.equal(f.items.get(1)!.fields["System.State"], "Closed");
  assert.equal((await f.command("sync")).ok, true);
});

test("round-5 Done mapped to CLOSED applies and replays through normalized agreement", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.command("import")).ok, true);
  const item = await row(f.pm);
  f.items.get(1)!.fields["System.State"] = "Done";
  f.items.get(1)!.fields["System.Title"] = "Reviewed Done title"; f.items.get(1)!.rev++;
  const previous = process.env.ADO_STATUS_MAP;
  process.env.ADO_STATUS_MAP = JSON.stringify({ Done: "CLOSED" });
  try {
    const service = resolver(f), plan = choices(await service.plan(item.id), "remote");
    assert.equal((await service.apply(plan)).ok, true);
    const before = snapshot(f.pmRoot);
    assert.equal((await service.apply(plan)).replayed, true);
    assert.deepEqual(snapshot(f.pmRoot), before);
    assert.equal((await f.pm.get(item.id)).item.status, "closed");
    assert.equal(f.items.get(1)!.fields["System.State"], "Done");
    assert.equal(f.requests.filter((request) => request.method === "PATCH").length, 0);
  } finally { if (previous === undefined) delete process.env.ADO_STATUS_MAP; else process.env.ADO_STATUS_MAP = previous; }
});

test("round-5 all configured mappings and SDK-accepted status spellings choose apply and replay without remote reversal", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.command("import")).ok, true);
  const item = await row(f.pm);
  await f.pm.schemaAddStatus("review_stage", { alias: ["Ready To Review", "ready-to-verify"], role: ["active"] });
  await f.pm.schemaAddStatus("constructor", { alias: ["Own Constructor"], role: ["active"] });
  const settings = await readSettings(f.pmRoot), registry = resolveRuntimeStatusRegistry(settings.schema);
  const old = process.env.ADO_STATUS_MAP;
  let cases = 0;
  try {
    for (const [wire, target] of Object.entries({ ...IMPORT_STATE_MAP, "Awaiting Review": "review_stage", constructor: "constructor" })) {
      const accepted = new Set([target, ...[...registry.alias_to_id].filter(([, canonical]) => canonical === target).map(([alias]) => alias)]);
      for (const alias of [...accepted]) for (const spelling of [alias, alias.toUpperCase(), ` \t${alias}\u00a0`, alias.replaceAll("_", "-")]) {
        if (runtimeSdk.normalizeStatusInput(spelling, registry) !== target) continue;
        process.env.ADO_STATUS_MAP = JSON.stringify({ [wire]: spelling });
        const remote = f.items.get(1)!;
        remote.fields["System.State"] = wire; remote.fields["System.Title"] = `Reviewed alias ${++cases}`; remote.rev++;
        await f.setFields(item.id, { ado_sync_base: JSON.stringify({ ado_base_partial: 1, relations: [] }) });
        const service = resolver(f), plan = choices(await service.plan(item.id), "remote");
        assert.equal((await service.apply(JSON.parse(JSON.stringify(plan)))).ok, true, `${wire}: ${spelling}`);
        assert.equal((await f.pm.get(item.id)).item.status, target, `${wire}: native status`);
        const before = snapshot(f.pmRoot);
        assert.equal((await service.apply(plan)).replayed, true, `${wire}: replay`);
        assert.deepEqual(snapshot(f.pmRoot), before, `${wire}: replay must be a no-op`);
        assert.equal(remote.fields["System.State"], wire, `${wire}: no reverse-map substitution`);
      }
    }
  } finally { if (old === undefined) delete process.env.ADO_STATUS_MAP; else process.env.ADO_STATUS_MAP = old; }
  assert.equal(f.requests.filter((request) => request.method === "PATCH").length, 0);
  t.diagnostic(`${cases} configured-map/SDK spelling cases; choose/apply/replay; no PATCH or remote state reversal`);
});

test("round-5 JSON and TOON plans, artifact apply, ID prefixes and map aliases share normalized coordinates", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.command("import")).ok, true);
  const item = await row(f.pm), remote = f.items.get(1)!;
  remote.fields["System.State"] = "Done"; remote.fields["System.Title"] = " \tReviewed CLI title\u00a0"; remote.rev++;
  f.env.ADO_STATUS_MAP = JSON.stringify({ Done: " CLOSED " });
  f.env.ADO_EXPORT_STATE_MAP = JSON.stringify({ " CLOSED ": "Done" });
  const id = ` #${item.id.toUpperCase()} `;
  const json = await f.host(["ado", "resolve-plan", "--item", id, "--json"]);
  assert.equal(json.code, 0, json.stdout + json.stderr);
  const plan = choices((JSON.parse(json.stdout) as { plan: ResolutionPlan }).plan, "remote");
  assert.equal(plan.local.id, item.id);
  assert.equal(plan.fields.find((field) => field.field === "status")!.remote, resolutionDigest("closed"));
  const toon = await f.host(["ado", "resolve-plan", "--item", item.id.slice("fixture-".length), "--output-format", "toon"]);
  assert.equal(toon.code, 0, toon.stdout + toon.stderr); assert.ok(toon.stdout.includes(resolutionDigest("closed")));
  const artifact = join(f.root, "normalized-plan.json"); writeFileSync(artifact, JSON.stringify(plan));
  // Equivalent SDK spellings in configuration cannot reinterpret the semantic plan.
  f.env.ADO_STATUS_MAP = JSON.stringify({ Done: "closed" });
  f.env.ADO_EXPORT_STATE_MAP = JSON.stringify({ closed: "Done" });
  const applied = await f.host(["ado", "resolve-apply", "--artifact", artifact, "--json"]);
  assert.equal(applied.code, 0, applied.stdout + applied.stderr);
  const before = snapshot(f.pmRoot);
  plan.local.id = ` #${item.id.toUpperCase()} `; writeFileSync(artifact, JSON.stringify(plan));
  const replayed = await f.host(["ado", "resolve-apply", "--artifact", artifact, "--output-format", "toon"]);
  assert.equal(replayed.code, 0, replayed.stdout + replayed.stderr); assert.match(replayed.stdout, /replayed: true/u);
  assert.deepEqual(snapshot(f.pmRoot), before);
  const settled = (await f.pm.get(item.id)).item; assert.equal(settled.status, "closed"); assert.equal(settled.title, "Reviewed CLI title");
  assert.equal(f.requests.filter((request) => request.method === "PATCH").length, 0);
});

test("round-5 actual released version-2 plans pending intents and receipts remain readable and replayable", async (t) => {
  const released = join(repo, "test/fixtures/normalization/released-2026.10.26");
  const provenance = JSON.parse(readFileSync(join(released, "provenance.json"), "utf8")) as { version: string; integrity: string };
  assert.equal(provenance.version, "2026.10.26"); assert.match(provenance.integrity, /^sha512-/u);
  for (const state of ["prepared", "settled"]) await t.test(state, async (sub) => {
    const root = mkdtempSync(join(tmpdir(), "ado-legacy-v2-")); sub.after(() => rmSync(root, { recursive: true, force: true }));
    const pmRoot = join(root, ".agents/pm"); cpSync(join(released, state), pmRoot, { recursive: true });
    const installed = join(pmRoot, "extensions/pm-ado"); mkdirSync(installed, { recursive: true });
    cpSync(join(repo, "dist"), join(installed, "dist"), { recursive: true }); cpSync(join(repo, "manifest.json"), join(installed, "manifest.json"));
    mkdirSync(join(root, "node_modules/@unbrained"), { recursive: true }); symlinkSync(join(repo, "node_modules/@unbrained/pm-cli"), join(root, "node_modules/@unbrained/pm-cli"), "junction");
    const pm = new PmClient({ cwd: root, pmRoot, author: "fixture-agent" });
    const plan = JSON.parse(readFileSync(join(released, "plan.json"), "utf8")) as ResolutionPlan;
    assert.equal(plan.normalization, undefined);
    const remote = JSON.parse(readFileSync(join(released, "remote.json"), "utf8")) as AdoWorkItem;
    const config = { orgUrl: "https://fixture.invalid/organization", project: "Project", token: "synthetic-token" };
    let writes = 0;
    const client = new AdoClient(config, async (method) => { if (method === "PATCH") writes++; return { status: 200, body: JSON.stringify({ value: [remote] }) }; });
    const previous = process.env.ADO_STATUS_MAP, cwd = process.cwd(); process.env.ADO_STATUS_MAP = JSON.stringify({ Done: "CLOSED" }); process.chdir(root);
    try {
      const historyPath = join(pmRoot, "history", `${plan.local.id}.jsonl`), originalHistory = readFileSync(historyPath, "utf8");
      const service = new AdoResolutionService(pmRoot, "fixture-agent", pm, client, config, runtimeSdk);
      assert.equal((await service.apply(plan)).ok, true);
      const settled = (await pm.get(plan.local.id)).item; assert.equal(settled.status, "closed"); assert.equal(settled.ado_resolution_intent, undefined);
      assert.ok(readFileSync(historyPath, "utf8").startsWith(originalHistory), "released history stays byte-prefix intact");
      const before = snapshot(pmRoot);
      assert.equal((await service.apply(plan)).replayed, true); assert.deepEqual(snapshot(pmRoot), before);
      assert.equal(writes, 0);
    } finally { process.chdir(cwd); if (previous === undefined) delete process.env.ADO_STATUS_MAP; else process.env.ADO_STATUS_MAP = previous; }
  });
});


test("round-5 injected SDK normalization and canonical scope work without a package module link", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.command("import")).ok, true);
  const item = await row(f.pm), remote = f.items.get(1)!;
  const isolated = mkdtempSync(join(tmpdir(), "ado-injected-runtime-"));
  t.after(() => rmSync(isolated, { recursive: true, force: true }));
  cpSync(join(repo, "dist"), join(isolated, "dist"), { recursive: true });
  writeFileSync(join(isolated, "package.json"), JSON.stringify({ type: "module" }));
  const request = createRequire(join(isolated, "dist/index.js"));
  assert.throws(() => request.resolve("@unbrained/pm-cli/sdk"), /Cannot find module/u);
  const copied = request(join(isolated, "dist/index.js")) as typeof Package;
  const config = { orgUrl: f.org, project: "Project", token: "synthetic-token" };
  const padded = { ...config, orgUrl: ` ${f.org}/// `, project: " Project " };
  assert.equal(copied.resolutionScopeReference(padded), copied.resolutionScopeReference(config));
  assert.notEqual(copied.resolutionScopeReference(padded, true), copied.resolutionScopeReference(config, true));
  const old = process.env.ADO_STATUS_MAP; process.env.ADO_STATUS_MAP = JSON.stringify({ Done: " CLOSED " });
  try {
    remote.fields["System.State"] = "Done"; remote.fields["System.Title"] = " Injected API title "; remote.rev++;
    const client = new copied.AdoClient(config, transport);
    const producer = new copied.AdoResolutionService(f.pmRoot, "fixture-agent", f.pm, client, padded, runtimeSdk);
    const consumer = new copied.AdoResolutionService(f.pmRoot, "fixture-agent", f.pm, client, config, runtimeSdk);
    const plan = choices(await producer.plan(` #${item.id.toUpperCase()} `), "remote");
    assert.equal((await consumer.apply(plan)).ok, true);
    const before = snapshot(f.pmRoot);
    assert.equal((await producer.apply(plan)).replayed, true);
    assert.deepEqual(snapshot(f.pmRoot), before);
    const settled = (await f.pm.get(item.id)).item;
    assert.equal(settled.status, "closed"); assert.equal(settled.title, "Injected API title");
    assert.equal(remote.fields["System.State"], "Done");
    assert.equal(f.requests.filter((request) => request.method === "PATCH").length, 0);
  } finally { if (old === undefined) delete process.env.ADO_STATUS_MAP; else process.env.ADO_STATUS_MAP = old; }
});
