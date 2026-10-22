/** REST metadata contracts, real host rendering and non-git SDK tracker checks. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import * as built from "../dist/index.js";
import extension, { AdoClient, CommandError, ContractRefusal, discoverProjectContract, RELATION_MAP, type AdoTransport, type ProjectContract } from "../index.ts";
import { ADO_FIELD_MAP, transport } from "../sync.ts";

const config = { orgUrl: "https://dev.azure.com/example", project: "Example Project", token: "synthetic-secret" };
const run = promisify(execFile);
const repo = resolve(import.meta.dirname, "..");

/** Build documented REST 7.1 metadata; callers change one behavior at a time. */
function fixture() {
  const fields = Object.entries(ADO_FIELD_MAP).map(([local, referenceName]) => ({ referenceName, type: local === "priority" ? "integer" : "string", readOnly: false }));
  const typeFields: Record<string, unknown>[] = fields.map((field) => ({ referenceName: field.referenceName, alwaysRequired: field.referenceName === "System.Title", allowedValues: [], dependentFields: [] }));
  const types: Record<string, unknown>[] = [{ name: "Task", referenceName: "Example.Task", isDisabled: false, states: ["New", "Active", "Closed"].map((name) => ({ name })) }];
  const relations: Record<string, unknown>[] = Object.keys(RELATION_MAP).map((referenceName) => ({ referenceName, attributes: { enabled: true, editable: true, usage: "workItemLink" } }));
  const calls: { method: string; url: string; body: string | undefined }[] = [];
  const overrides = new Map<string, { status: number; body: string }>();
  /** Only fixed metadata routes are accepted; writes fail the test immediately. */
  const request: AdoTransport = async (method, url, body, headers) => {
    calls.push({ method, url, body });
    assert.equal(method, "GET"); assert.equal(body, undefined);
    assert.equal(headers.Authorization, `Basic ${Buffer.from(`:${config.token}`).toString("base64")}`);
    const path = new URL(url).pathname.split("/_apis/wit/")[1]!;
    const override = overrides.get(path);
    if (override) return override;
    const values = path === "fields" ? fields : path === "workitemtypes" ? types : path === "workitemrelationtypes" ? relations : typeFields;
    return { status: 200, body: JSON.stringify({ count: values.length, value: values }) };
  };
  return { fields, typeFields, types, relations, calls, request, overrides };
}

/** Assert typed refusal codes and secret-free messages/remedies. */
async function refused(action: Promise<unknown>, code: string) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof ContractRefusal);
    assert.equal(error.code, code); assert.ok(error.remedy.length > 10);
    assert.doesNotMatch(`${error.message} ${error.remedy}`, /synthetic-secret|server-secret/u);
    return true;
  });
}

test("discovers a complete compatible contract with GET only and exports the typed surface", async () => {
  const f = fixture();
  const result = await discoverProjectContract(config, f.request);
  assert.equal(result.ok, true); assert.equal(result.preview, true); assert.equal(result.compatible, true);
  assert.equal(result.types[0]!.fields.length, 8); assert.equal(result.relations.length, 7);
  assert.equal(result.permissions.relation_write, "unknown"); assert.equal(result.permissions.field_write, "unknown");
  assert.equal(result.checked_items, 0); assert.match(result.fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(f.calls.length, 4); assert.ok(f.calls[0]!.url.includes("/Example%20Project/"));
  assert.ok(f.calls[2]!.url.includes("$expand=all"));
  assert.equal(new URL(f.calls[3]!.url).pathname, "/example/_apis/wit/workitemrelationtypes");
  assert.equal(typeof built.discoverProjectContract, "function");
});

test("custom types retain required, allowed, default and dependent field metadata", async () => {
  const f = fixture();
  f.types.push({ name: "Custom / Review", referenceName: "Custom.Review", states: [{ name: "Review" }] });
  f.fields.push({ referenceName: "Custom.Score", type: "double", readOnly: false });
  f.typeFields.push({ referenceName: "Custom.Score", alwaysRequired: true, allowedValues: [1, 2], defaultValue: 1, dependentFields: [{ referenceName: "System.Title" }] });
  assert.equal((await discoverProjectContract(config, f.request)).types.length, 2);
  const result = await discoverProjectContract(config, f.request, { type: "Custom / Review" });
  assert.equal(result.types.length, 1); assert.equal(result.types[0]!.name, "Custom / Review");
  assert.ok(f.calls.some((call) => call.url.includes("Custom%20%2F%20Review")));
  assert.deepEqual(result.types[0]!.fields.find((field) => field.ref === "Custom.Score"), { ref: "Custom.Score", type: "double", writable: true, required: true, allowed: [1, 2], default: 1, depends_on: ["System.Title"] });
  assert.ok(result.issues.some((issue) => issue.code === "export_state"));
  assert.ok(result.issues.some((issue) => issue.code === "import_state"));
});

test("reports read-only fields, missing fields, incompatible data types and required custom values", async () => {
  const f = fixture();
  f.fields[0]!.readOnly = true; f.fields[1]!.type = "dateTime";
  f.typeFields.splice(2, 1);
  f.fields.push({ referenceName: "Custom.Required", type: "string", readOnly: false });
  f.typeFields.push({ referenceName: "Custom.Required", alwaysRequired: true });
  f.types[0]!.isDisabled = true;
  const result = await discoverProjectContract(config, f.request);
  for (const code of ["read_only", "missing_field", "field_type", "required_unmapped", "item_type"]) assert.ok(result.issues.some((issue) => issue.code === code), code);
  assert.equal(result.compatible, false);
  assert.equal(result.types[0]!.fields.find((field) => field.ref === "System.Title")!.writable, false);
});

test("relation metadata never grants permissions and unavailable mappings are actionable", async () => {
  const f = fixture();
  f.relations.shift();
  f.relations[0]!.attributes = { enabled: false, editable: false, usage: "resourceLink" };
  f.relations[1]!.attributes = {};
  f.relations.push({ referenceName: "Custom.Link", attributes: { enabled: true, editable: true } });
  const result = await discoverProjectContract(config, f.request);
  assert.equal(result.issues.filter((issue) => issue.code === "relation_unavailable").length, 3);
  assert.deepEqual(result.relations.find((relation) => relation.ref === "Custom.Link"), { ref: "Custom.Link", enabled: true, editable: true, usage: null, mapped: null });
  assert.equal(result.permissions.relation_write, "unknown");
});

test("schema fingerprints are order-stable, scoped and change on remote metadata drift", async () => {
  const f = fixture();
  const first = await discoverProjectContract(config, f.request);
  f.fields.reverse(); f.typeFields.reverse(); f.relations.reverse();
  const same = await discoverProjectContract(config, f.request, { expectedFingerprint: first.fingerprint, exportStates: { open: "New" } });
  assert.equal(same.fingerprint, first.fingerprint);
  f.fields[0]!.readOnly = true;
  await refused(discoverProjectContract(config, f.request, { expectedFingerprint: first.fingerprint }), "schema_changed");
  const changed = await discoverProjectContract(config, f.request);
  assert.notEqual(changed.fingerprint, first.fingerprint);
});

test("permission, missing scope, remote, network and invalid JSON refusals are typed", async () => {
  for (const [status, code] of [[401, "permission_denied"], [403, "permission_denied"], [404, "not_found"], [429, "remote_failure"], [500, "remote_failure"], [199, "remote_failure"], [302, "remote_failure"]] as const) {
    const f = fixture(); f.overrides.set("fields", { status, body: "server-secret" });
    await refused(discoverProjectContract(config, f.request), code); assert.equal(f.calls.length, 1);
  }
  const f = fixture(); f.overrides.set("fields", { status: 200, body: "server-secret" });
  await refused(discoverProjectContract(config, f.request), "invalid_schema");
  await refused(discoverProjectContract(config, async () => { throw new Error("server-secret"); }), "remote_failure");
  await refused(discoverProjectContract(config, fixture().request, { type: "Missing" }), "not_found");
  const empty = fixture(); empty.types.splice(0); await refused(discoverProjectContract(config, empty.request), "not_found");
});

test("invalid selection and credential-bearing URLs fail before any HTTP request", async () => {
  for (const changes of [{ orgUrl: "invalid" }, { orgUrl: "ftp://example.invalid" }, { orgUrl: "http://example.invalid" }, { orgUrl: "https://user:secret@example.invalid" }, { orgUrl: "https://example.invalid/?q=secret" }, { orgUrl: "https://example.invalid/#secret" }, { project: " " }, { project: "." }, { project: ".." }, { token: " " }]) {
    const f = fixture(); await refused(discoverProjectContract({ ...config, ...changes }, f.request), "configuration"); assert.equal(f.calls.length, 0);
  }
  for (const type of [" ", ".", ".."]) await refused(discoverProjectContract(config, fixture().request, { type }), "configuration");
});

test("schema shape changes fail closed instead of inventing writable/required values", async () => {
  const invalid: unknown[] = [null, [], {}, { value: null }, { count: 1, value: [] }, { count: 1, value: [null] }, { count: 1, value: [{ referenceName: "" }] }, { count: 2, value: [{ referenceName: "x" }, { referenceName: "x" }] }];
  for (const body of invalid) {
    const f = fixture(); f.overrides.set("fields", { status: 200, body: JSON.stringify(body) });
    await refused(discoverProjectContract(config, f.request), "invalid_schema");
  }
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.fields[0]!.type = ""; },
    (f: ReturnType<typeof fixture>) => { delete (f.fields[0] as Record<string, unknown>).readOnly; },
    (f: ReturnType<typeof fixture>) => { f.typeFields[0]!.referenceName = "Missing.Field"; },
    (f: ReturnType<typeof fixture>) => { delete f.typeFields[0]!.alwaysRequired; },
    (f: ReturnType<typeof fixture>) => { f.typeFields[0]!.allowedValues = "all"; },
    (f: ReturnType<typeof fixture>) => { f.types[0]!.isDisabled = "no"; },
    (f: ReturnType<typeof fixture>) => { f.types[0]!.states = null; },
    (f: ReturnType<typeof fixture>) => { f.relations[0]!.attributes = null; },
    (f: ReturnType<typeof fixture>) => { f.relations[0]!.attributes = { usage: 1 }; },
  ]) { const f = fixture(); change(f); await refused(discoverProjectContract(config, f.request), "invalid_schema"); }
});

/** Snapshot authoritative tracker bytes; derived host caches are not tracker mutations. */
function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      if (!path.includes(`${join(root, "runtime")}/`)) result[path.slice(root.length)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  }
  return result;
}

/** Serve synthetic metadata over actual HTTP and create a real disposable non-git tracker. */
async function hostFixture(t: test.TestContext) {
  const f = fixture();
  const server = createServer(async (req, res) => {
    const response = await f.request(req.method!, `http://localhost${req.url}`, undefined, { Authorization: req.headers.authorization! });
    res.writeHead(response.status, { "Content-Type": "application/json" }); res.end(response.body);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const root = mkdtempSync(join(tmpdir(), "ado-contract-"));
  const pmRoot = join(root, ".agents/pm");
  const pm = new PmClient({ cwd: root, pmRoot, author: "fixture-agent" });
  await pm.run("init", { prefix: "fixture" });
  const item = await pm.create({ title: "Synthetic task", type: "Task" });
  const installed = join(pmRoot, "extensions/pm-ado"); mkdirSync(installed, { recursive: true });
  cpSync(join(repo, "dist"), join(installed, "dist"), { recursive: true }); cpSync(join(repo, "manifest.json"), join(installed, "manifest.json"));
  const noGit = join(root, "bin"); mkdirSync(noGit); symlinkSync(process.execPath, join(noGit, "node"));
  const env = { ...process.env, ADO_ORG_URL: `http://127.0.0.1:${address.port}/example`, ADO_TOKEN: config.token, ADO_PROJECT: "Ignored implicit project", ADO_EXPORT_STATE_MAP: "{}", ADO_STATUS_MAP: "{}", PM_NO_UPDATE_CHECK: "1", PM_AUTHOR: "fixture-agent", GIT_CEILING_DIRECTORIES: tmpdir(), PATH: noGit };
  const harness = await createExtensionTestHarness(extension, { name: "pm-ado", capabilities: ["commands", "schema", "preflight"] });
  assert.deepEqual(harness.activation.failed, []);
  /** Run the registered handler with the real host SDK, preserving process globals. */
  const command = async (options: Record<string, unknown>, sdk = true, changes: Record<string, string | undefined> = {}) => {
    const before = process.env; const exit = process.exitCode; const cwd = process.cwd();
    process.env = { ...env, ...changes }; process.chdir(root);
    try { return (await harness.runCommand({ command: "ado contract", pmRoot: sdk ? pmRoot : undefined, options })).result; }
    finally { process.env = before; process.exitCode = exit; process.chdir(cwd); }
  };
  /** Execute the installed extension with the actual parser and renderer. */
  const cli = async (args: string[], changes: Record<string, string> = {}) => {
    try { const result = await run(process.execPath, [join(repo, "node_modules/@unbrained/pm-cli/dist/cli.js"), "--pm-path", pmRoot, "ado", "contract", ...args], { cwd: root, env: { ...env, ...changes }, maxBuffer: 8 * 1024 * 1024 }); return { ...result, code: 0 }; }
    catch (error) { return error as { stdout: string; stderr: string; code: number }; }
  };
  t.after(async () => { await new Promise<void>((done) => server.close(() => done())); rmSync(root, { recursive: true, force: true }); });
  return { ...f, root, pmRoot, pm, item, command, cli, env };
}

test("non-git command previews complete SDK values without remote or authoritative tracker mutations", async (t) => {
  const f = await hostFixture(t);
  const title = f.typeFields.find((field) => field.referenceName === "System.Title")!;
  title.allowedValues = ["Allowed"];
  await f.pm.create({ title: "Another title", type: "Task" });
  const before = snapshot(f.pmRoot);
  const result = await f.command({ project: config.project, type: "Task", checkTracker: true }) as ProjectContract;
  assert.equal(result.checked_items, 2);
  assert.equal(result.issues.find((issue) => issue.code === "item_value")!.count, 2);
  assert.deepEqual(snapshot(f.pmRoot), before);
  assert.ok(f.calls.every((call) => call.method === "GET"));
  const json = await f.cli(["--project", config.project, "--type", "Task", "--check-tracker", "--json"]);
  assert.equal(json.code, 0, json.stderr); assert.equal(JSON.parse(json.stdout).checked_items, 2);
  const toon = await f.cli(["--project", config.project, "--type", "Task", "--output-format", "toon"]);
  assert.equal(toon.code, 0, toon.stderr); assert.match(toon.stdout, /fingerprint:/u); assert.match(toon.stdout, /preview: true/u);
  assert.deepEqual(snapshot(f.pmRoot), before);
  const noSelection = await f.cli(["--json"]); assert.equal(noSelection.code, 2); assert.equal(JSON.parse(noSelection.stdout).code, "configuration");
  f.overrides.set("fields", { status: 403, body: "server-secret" });
  const denied = await f.cli(["--project", config.project, "--json"]); assert.equal(denied.code, 3); assert.equal(JSON.parse(denied.stdout).code, "permission_denied");
  assert.doesNotMatch(denied.stdout, /server-secret|synthetic-secret/u);
});

test("complete real SDK items report unknown types, status mappings and required values", async (t) => {
  const f = await hostFixture(t);
  const items = (await f.pm.listAllComplete()).items;
  const first = items[0]!;
  const result = await discoverProjectContract(config, fixture().request, { items: [{ ...first, ado_type: "Custom" }, { ...first, status: "custom" }, { ...first, title: "" }] });
  assert.ok(result.issues.some((issue) => issue.code === "item_type" && issue.target === "Custom"));
  assert.ok(result.issues.some((issue) => issue.code === "export_state" && issue.target === "Task/custom"));
  assert.ok(result.issues.some((issue) => issue.code === "item_value"));
  const custom = fixture();
  custom.fields.push({ referenceName: "Custom.Note", type: "string", readOnly: false });
  custom.typeFields.push({ referenceName: "Custom.Note", alwaysRequired: false });
  assert.equal((await discoverProjectContract(config, custom.request, { items })).checked_items, 1);
  const disabled = fixture(); disabled.types[0]!.isDisabled = true;
  assert.ok((await discoverProjectContract(config, disabled.request, { items })).issues.some((issue) => issue.code === "item_type"));
  const selected = fixture(); selected.types[0]!.name = "Custom";
  assert.equal((await discoverProjectContract(config, selected.request, { type: "Custom", items })).checked_items, 1);
});

test("handler validates configuration, maps and schema pins with typed shell exits", async (t) => {
  const f = await hostFixture(t);
  for (const options of [{}, { project: 1 }, { project: " " }, { project: "Example", type: 1 }, { project: "Example", expectFingerprint: 7 }, { project: "Example", "expect-fingerprint": "bad" }]) {
    const result = await f.command(options) as { code: string; exit_code: number }; assert.equal(result.code, "configuration"); assert.equal(result.exit_code, 2);
  }
  for (const changes of [{ ADO_ORG_URL: undefined }, { ADO_TOKEN: " " }, { ADO_STATUS_MAP: "invalid" }]) assert.equal((await f.command({ project: "Example" }, true, changes) as { code: string }).code, "configuration");
  assert.equal((await f.command({ project: "Example", checkTracker: true }, false) as { code: string }).code, "configuration");
  const good = await f.command({ project: "Example" }, false) as ProjectContract;
  assert.equal(good.ok, true);
  const changed = await f.command({ project: "Example", "expect-fingerprint": "0".repeat(64) }) as { code: string; exit_code: number };
  assert.equal(changed.code, "schema_changed"); assert.equal(changed.exit_code, 4);
  assert.equal((await f.command({ project: "Example", "check-tracker": true, expectFingerprint: good.fingerprint }) as ProjectContract).ok, true);
  const invalidStatus = await f.command({ project: "Example", checkTracker: true }, true, { ADO_STATUS_MAP: '{"New":"missing_local_status"}' }) as ProjectContract;
  assert.ok(invalidStatus.issues.some((issue) => issue.code === "import_state"));
});

test("discovery refuses redirects while shared sync client transport preserves redirect following", async (t) => {
  const f = await hostFixture(t);
  let followed = 0;
  let initial = 0;
  const server = createServer((req, res) => {
    if (req.url === "/redirected") {
      followed++; res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ count: 0, value: [] }));
    } else { initial++; res.writeHead(302, { Location: "/redirected" }); res.end(); }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const orgUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await new Promise<void>((done) => server.close(() => done())); });
  const read = await new AdoClient({ ...config, orgUrl }, transport).request("GET", "/_apis/wit/fields?api-version=7.1");
  assert.deepEqual(read, { count: 0, value: [] }); assert.equal(followed, 1);
  const refusal = await f.command({ project: config.project }, false, { ADO_ORG_URL: orgUrl }) as { code: string; exit_code: number };
  assert.equal(refusal.code, "remote_failure"); assert.equal(refusal.exit_code, 3);
  assert.equal(followed, 1, "discovery must not follow the redirect"); assert.equal(initial, 2);
});

/** Discover identical Unicode metadata under two actual process default ICU locales. */
test("fingerprints and output ordering are independent of process ICU locale", async () => {
  const f = fixture();
  for (const ref of ["Custom.ä", "Custom.z", "Custom.A"]) {
    f.fields.push({ referenceName: ref, type: "string", readOnly: false });
    f.typeFields.push({ referenceName: ref, alwaysRequired: false, allowedValues: [{ ä: 1, z: 2 }, "ä", "z", "z"] });
  }
  for (const name of ["ä Task", "z Task"]) f.types.push({ name, referenceName: name, states: [{ name: "New" }] });
  f.relations.push({ referenceName: "Custom.ä", attributes: {} }, { referenceName: "Custom.z", attributes: {} });
  const script = `import { discoverProjectContract } from ${JSON.stringify(pathToFileURL(join(repo, "dist/index.js")).href)};
    const data = JSON.parse(process.argv[1]);
    const contract = await discoverProjectContract(data.config, async (_method, url) => {
      const path = new URL(url).pathname.split("/_apis/wit/")[1];
      const value = path === "fields" ? data.fields : path === "workitemtypes" ? data.types : path === "workitemrelationtypes" ? data.relations : data.typeFields;
      return { status: 200, body: JSON.stringify({ count: value.length, value }) };
    });
    console.log(JSON.stringify({ locale: Intl.DateTimeFormat().resolvedOptions().locale, contract }));`;
  const input = JSON.stringify({ config, fields: f.fields, typeFields: f.typeFields, types: f.types, relations: f.relations });
  const results: { locale: string; contract: ProjectContract }[] = [];
  for (const locale of ["en_US.UTF-8", "sv_SE.UTF-8"]) {
    const result = await run(process.execPath, ["--input-type=module", "-e", script, input], { env: { ...process.env, LANG: locale, LC_ALL: locale }, maxBuffer: 4 * 1024 * 1024 });
    results.push(JSON.parse(result.stdout) as { locale: string; contract: ProjectContract });
  }
  assert.notEqual(results[0]!.locale, results[1]!.locale, "the regression must exercise distinct process locales");
  assert.deepEqual(results[0]!.contract, results[1]!.contract);
});

test("type-filtered tracker checks skip enabled out-of-scope types but diagnose unknown and disabled types", async (t) => {
  const f = await hostFixture(t);
  f.types.push({ name: "Bug", referenceName: "Custom.Bug", isDisabled: false, states: [{ name: "New" }] },
    { name: "Disabled", referenceName: "Custom.Disabled", isDisabled: true, states: [{ name: "New" }] });
  const first = (await f.pm.listAllComplete()).items[0]!;
  const items = [{ ...first, ado_type: "Task" }, { ...first, ado_type: "Bug" }];
  const scoped = await discoverProjectContract(config, f.request, { type: "Task", items });
  assert.equal(scoped.compatible, true); assert.deepEqual(scoped.issues, []);
  assert.equal(scoped.checked_items, 1); assert.equal(scoped.skipped_items, 1);
  const invalid = await discoverProjectContract(config, f.request, { type: "Task", items: [...items,
    { ...first, ado_type: "Missing" }, { ...first, ado_type: "Disabled" }] });
  assert.equal(invalid.checked_items, 3); assert.equal(invalid.skipped_items, 1);
  assert.deepEqual(invalid.issues.map((issue) => [issue.code, issue.target]), [["item_type", "Missing"], ["item_type", "Disabled"]]);
  const unscoped = await discoverProjectContract(config, f.request, { items });
  assert.equal(unscoped.checked_items, 2); assert.equal(unscoped.skipped_items, 0);
  // Persist a real provider type through the host SDK, then exercise CLI accounting.
  const cwd = process.cwd(); process.chdir(f.root);
  try { await f.pm.update(first.id, { field: ["ado_type=Bug"] }); }
  finally { process.chdir(cwd); }
  const cli = await f.cli(["--project", config.project, "--type", "Task", "--check-tracker", "--json"]);
  assert.equal(cli.code, 0, cli.stderr);
  const output = JSON.parse(cli.stdout) as ProjectContract;
  assert.equal(output.compatible, true); assert.equal(output.checked_items, 0); assert.equal(output.skipped_items, 1);
});

test("complete-tracker SDK failures retain non-configuration refusal categories", async (t) => {
  const trackerFixture = await hostFixture(t);
  const file = readdirSync(trackerFixture.pmRoot, { recursive: true, encoding: "utf8" }).find((path) => path.endsWith(`/${trackerFixture.item.item.id}.toon`));
  assert.ok(file);
  writeFileSync(join(trackerFixture.pmRoot, file), "invalid [tracker data");
  const trackerFailure = await trackerFixture.command({ project: config.project, checkTracker: true }) as { code: string; exit_code: number; remedy: string };
  assert.equal(trackerFailure.code, "remote_failure"); assert.equal(trackerFailure.exit_code, 3);
  assert.match(trackerFailure.remedy, /complete tracker read/u); assert.equal(trackerFixture.calls.length, 0);
  const invalidMap = await trackerFixture.command({ project: config.project }, false, { ADO_STATUS_MAP: "{invalid map" }) as { code: string; exit_code: number };
  assert.equal(invalidMap.code, "configuration"); assert.equal(invalidMap.exit_code, 2);
});


test("refusal normalization preserves typed failures and classifies other errors without leaking details", () => {
  const typed = new ContractRefusal("schema_changed", "Review metadata", 4);
  assert.equal(ContractRefusal.from(typed), typed);
  const configuration = ContractRefusal.from(new CommandError("server-secret"));
  assert.equal(configuration.code, "configuration"); assert.equal(configuration.exitCode, 2);
  for (const error of [new CommandError("server-secret", 3), new TypeError("server-secret"), new Error("server-secret")]) {
    const failure = ContractRefusal.from(error);
    assert.equal(failure.code, "remote_failure"); assert.equal(failure.exitCode, 3);
    assert.doesNotMatch(failure.message + failure.remedy, /server-secret/u);
  }
});
