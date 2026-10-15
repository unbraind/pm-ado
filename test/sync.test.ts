/** Real host commands against a local Azure REST subset and disposable SDK trackers. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { type AdoWorkItem, type AdoRelation, type JsonPatchOperation } from "../index.ts";
import { buildWiql, localValues, remoteValues, IMPORT_STATE_MAP } from "../sync.ts";

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
  let vanish = false;
  let omitRelations = false;
  const responses = new Map<string, unknown>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fixture.invalid");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> & JsonPatchOperation[] : undefined;
    requests.push({ method: req.method!, path: req.url!, body });
    assert.equal(url.searchParams.get("api-version"), "7.1");
    assert.equal(req.headers.authorization, `Basic ${Buffer.from(":synthetic-token").toString("base64")}`);
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
      send(200, { queryType: "flat", queryResultType: "workItem", workItems: [...items.keys()].slice(0, Number(url.searchParams.get("$top") ?? items.size)).map((id) => ({ id, url: `${org}/_apis/wit/workItems/${id}` })) }); return;
    }
    if (url.pathname.endsWith("/workitemsbatch")) {
      assert.equal(req.method, "POST");
      assert.equal(body!.$expand, "relations");
      assert.equal(body!.errorPolicy, "omit");
      assert.ok((body!.ids as number[]).length <= 200);
      send(200, { count: items.size, value: omit ? [] : (body!.ids as number[]).flatMap((id) => items.has(id) ? [items.get(id)] : []) }); return;
    }
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
      items.set(id, item); send(200, omitRelations ? { ...item, relations: undefined } : item); return;
    }
    assert.equal(req.method, "PATCH");
    const current = items.get(Number(tail))!;
    if (race) { current.rev++; current.fields["System.Title"] = "Concurrent writer"; race = false; }
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
    items.set(next.id, next); send(200, omitRelations ? { ...next, relations: undefined } : next);
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
  writeFileSync(join(installed, "manifest.json"), readFileSync(join(repo, "manifest.json")));
  const env: NodeJS.ProcessEnv = { ...process.env, PM_AUTHOR: "fixture-agent", PM_NO_UPDATE_CHECK: "1", ADO_ORG_URL: org,
    ADO_PROJECT: "Project", ADO_TOKEN: "synthetic-token" };
  delete env.ADO_STATUS_MAP;
  delete env.ADO_EXPORT_STATE_MAP;
  delete env.ADO_WORK_ITEM_TYPE;
  const harness = await createExtensionTestHarness(extension, { name: "pm-ado", capabilities: ["commands", "schema", "preflight"] });
  assert.deepEqual(harness.activation.failed, []);
  /** Execute through real registration with the real host-created SDK client. */
  const command = async (mode: string, options: Record<string, unknown> = {}) => {
    const before = { ...process.env };
    const cwd = process.cwd();
    process.chdir(root);
    process.env = { ...env };
    try {
      const result = await harness.runCommand({ command: `ado ${mode}`, pmRoot: options.withoutSdk ? undefined : pmRoot, options });
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
  return { pm, pmRoot, org, items, requests, command, host, env, setFields,
    response: (endpoint: string, value: unknown) => { responses.set(endpoint, value); },
    failPatch: (status: number) => { patchStatus = status; },
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
      if (entry.isSymbolicLink() || entry.name === "runtime" || entry.name === "extensions") continue;
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
  assert.equal((await f.command("sync")).ok, true);
  const a = (await f.pm.listAllComplete()).items.find((item) => item.ado_id === 1)!;
  assert.ok(a.dependencies!.length);
  f.items.get(1)!.relations = [];
  f.items.get(1)!.rev++;
  const before = snapshot(f.pmRoot);
  assert.equal((await f.command("sync")).code, "ADO_CONFLICT");
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
    assert.equal(item.ado_rev, 1);
    assert.equal(item.ado_project, "Project");
    assert.equal(item.ado_org_url, f.org);
    assert.equal(item.ado_url, `${f.org}/_apis/wit/workItems/${plan.ado_id}`);
    assert.equal(item.ado_sync_base, undefined, "partial publication must not invent a shared base");
    assert.deepEqual(plan.linked_fields, ["ado_id", "ado_rev", "ado_project", "ado_org_url", "ado_url"]);
    const history = readFileSync(join(f.pmRoot, "history", `${item.id}.jsonl`), "utf8");
    assert.match(history, /Linked to Azure DevOps work item/u);
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
