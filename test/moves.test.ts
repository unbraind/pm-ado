import { installFixtureExtension, fixtureItemPath, fixtureDirectory, packageRoot as repo } from "./helpers/package-runtime.ts";
import { authoritativeDigest as snapshot } from "./helpers/authoritative-digest.ts";
import { relocateNodePreloads, runCommand as run } from "./helpers/process-fixture.ts";
/** Real SDK trackers, deterministic Azure rule validation, bounded reads and installed no-git CLI. */
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PmClient, createExtensionCommandSdk, type ItemMetadata } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { ARTIFACT_LIMITS, ArtifactRefusal, observeArtifactPlan, ContractRefusal, MOVE_LIMITS, MoveRefusal, simulateMove, type AdoWorkItem, type ArtifactPlan, type MoveOptions, type MovePreview } from "../index.ts";
import * as built from "../dist/index.js";
import { runMoveCommand } from "../moves.ts";
import { moveItem, moveService } from "./fixtures/move-service.ts";

/** Build a real disposable non-git tracker and link its genuine SDK-created items in memory. */
async function fixture(t: test.TestContext, remote: AdoWorkItem[] = [moveItem(1)]) {
  const { root, cleanup } = fixtureDirectory("ado-moves-");
  t.after(cleanup);
  const pmRoot = join(root, ".agents/pm"), pm = new PmClient({ cwd: root, pmRoot, author: "fixture-agent" });
  await pm.run("init", { prefix: "fixture" });
  for (const item of remote) await pm.create({ title: `Public shaped task ${item.id}`, type: "Task" });
  const items = (await pm.listAllComplete()).items.map((item, index) => ({ ...item, ado_id: remote[index]!.id, ado_org_url: "https://dev.azure.com/example", ado_project: "Example" }));
  const f = moveService(remote);
  const options: MoveOptions = { items, ids: items.map((item) => item.id), areaPath: "Example\\New", iterationPath: "Example\\Release" };
  return { ...f, root, pmRoot, pm, options, preview: (changes: Partial<MoveOptions> = {}) => simulateMove(f.config, f.request, { ...options, ...changes }) };
}
/** A whole-preview refusal must remain typed, actionable and secret-free. */
async function refuses(action: Promise<unknown>, code: string) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof MoveRefusal || error instanceof ContractRefusal);
    assert.equal(error.code, code); assert.ok(error.remedy.length > 15);
    assert.doesNotMatch(`${error.message} ${error.remedy}`, /synthetic-move-token|server-secret/u);
    return true;
  });
}
/** Hash authoritative tracker files, excluding the SDK's derived runtime caches. */

test("inherited permissions and custom iteration rules produce deterministic independent rows without writes", async (t) => {
  const f = await fixture(t, [moveItem(1), moveItem(2, { "System.AreaPath": "Example\\Locked\\Child" }), moveItem(3, { "Custom.Ready": false })]);
  f.deniedAreas.add("Example\\Locked");
  const before = JSON.stringify([...f.items]); const tracker = snapshot(f.pmRoot);
  const result = await f.preview();
  const ordered = [...f.options.items].sort((a, b) => a.id < b.id ? -1 : 1);
  assert.deepEqual(result.rows.map((row) => row.id), ordered.map((item) => item.id));
  assert.deepEqual([...result.rows].sort((a, b) => a.ado_id - b.ado_id).map((row) => [row.decision, row.code]), [["allowed", null], ["refused", "permission_denied"], ["refused", "process_rule"]]);
  assert.equal(result.requests, 8); assert.equal(result.ok, false); assert.equal(result.preview, true);
  assert.deepEqual(await f.preview({ ids: [...f.options.ids].reverse() }), result);
  assert.equal(JSON.stringify([...f.items]), before); assert.deepEqual(snapshot(f.pmRoot), tracker);
  assert.ok((await f.preview({ areaPath: "Example\\Locked\\Child" })).rows.every((row) => row.code === "permission_denied"));
  assert.equal(typeof built.simulateMove, "function"); assert.deepEqual(built.MOVE_LIMITS, MOVE_LIMITS);
  assert.ok(f.calls.every((call) => call.method === "GET" || call.url.includes("workitemsbatch") || call.url.includes("validateOnly=true")));
});

test("relation scope changes preserve links, include allowed/refused endpoints and mark unreadable targets unknown", async (t) => {
  const one = moveItem(1), two = moveItem(2, { "Custom.Ready": false });
  const f = await fixture(t, [one, two]);
  const link = (id: number) => `${f.config.orgUrl}/_apis/wit/workItems/${id}`;
  f.items.get(1)!.relations = [{ rel: "System.LinkTypes.Dependency-Forward", url: link(2) }, { rel: "Custom.Link", url: link(3) }, { rel: "Missing.Link", url: link(4) }, { rel: "AttachedFile", url: "https://example.invalid/secret" }];
  f.items.get(2)!.relations = undefined;
  f.items.set(3, moveItem(3));
  const result = await f.preview();
  assert.equal(result.requests, 8); assert.equal(result.relations.length, 4);
  const edge = result.relations.find((row) => row.target === 2)!;
  assert.deepEqual(edge.before, { area: true, iteration: true }); assert.deepEqual(edge.after, { area: false, iteration: false });
  assert.equal(edge.action, "preserved");
  assert.equal(result.relations.find((row) => row.target === 4)!.after, null);
  assert.equal(result.relations.find((row) => row.target === null)!.before, null);
  assert.doesNotMatch(JSON.stringify(result), /example.invalid|Public shaped/u);
  assert.deepEqual((await f.preview()).relations, result.relations);
});

test("both allowed endpoints retain same-scope links; area-only and iteration-only preserve other dimensions", async (t) => {
  const f = await fixture(t, [moveItem(1), moveItem(2)]);
  f.items.get(1)!.relations = [{ rel: "Parent", url: `${f.config.orgUrl}/_apis/wit/workItems/2` }];
  const together = await f.preview();
  assert.equal(together.ok, true); assert.deepEqual(together.relations[0]!.after, { area: true, iteration: true });
  assert.equal((await f.preview({ iterationPath: undefined })).rows[0]!.after!.iteration, "Example\\Old Sprint");
  assert.equal((await f.preview({ areaPath: undefined, type: "Task" })).rows[0]!.after!.area, "Example\\Old");
});

test("selection and destination errors refuse before the first request", async (t) => {
  const f = await fixture(t);
  for (const ids of [[], ["absent"], [...f.options.ids, ...f.options.ids], Array.from({ length: 51 }, (_, i) => String(i))]) await refuses(f.preview({ ids }), "selection");
  for (const value of [undefined, "1", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) await refuses(f.preview({ items: [{ ...f.options.items[0]!, ado_id: value }] }), "selection");
  for (const changes of [{ ado_org_url: undefined }, { ado_org_url: "https://dev.azure.com/other" }, { ado_project: undefined }, { ado_project: "Other" }]) {
    await refuses(f.preview({ items: [{ ...f.options.items[0]!, ...changes }] }), "selection");
  }
  const second = { ...f.options.items[0]!, id: "fixture-other" };
  await refuses(f.preview({ items: [...f.options.items, second] }), "selection");
  await refuses(f.preview({ items: [...f.options.items, second], ids: [...f.options.ids, second.id] }), "selection");
  for (const areaPath of ["Other\\Area", "Example\\", "Example\\..", `Example\\${"x".repeat(1025)}`, 7 as unknown as string]) await refuses(f.preview({ areaPath }), "configuration");
  await refuses(f.preview({ areaPath: undefined, iterationPath: undefined }), "configuration");
  assert.equal(f.calls.length, 0);
});

test("single field contract prevents disabled/wrong types, wrong projects, missing/read-only/non-tree/enumerated fields", async (t) => {
  const f = await fixture(t);
  const original = structuredClone(f.items.get(1)!);
  for (const field of ["System.TeamProject", "System.WorkItemType"]) {
    f.items.get(1)!.fields[field] = "Other";
    assert.equal((await f.preview()).rows[0]!.code, "field_contract");
    f.items.set(1, structuredClone(original));
  }
  f.types[0]!.isDisabled = true; assert.equal((await f.preview()).rows[0]!.code, "field_contract"); f.types[0]!.isDisabled = false;
  const definition = { ...f.fields[0]! };
  for (const change of [{ readOnly: true }, { type: "string" }]) {
    Object.assign(f.fields[0]!, change); assert.equal((await f.preview()).rows[0]!.code, "field_contract"); Object.assign(f.fields[0]!, definition);
  }
  f.typeFields[0]!.allowedValues = ["Example\\Other"]; assert.equal((await f.preview()).rows[0]!.code, "field_contract"); f.typeFields[0]!.allowedValues = ["Example\\New"];
  assert.equal((await f.preview()).ok, true);
  f.typeFields.shift(); assert.equal((await f.preview()).rows[0]!.code, "field_contract");
  assert.ok(f.calls.filter((call) => call.method === "PATCH").length === 1);
});

test("missing selected items are explicit rows and remote validation failures are typed with remedies", async (t) => {
  const f = await fixture(t);
  for (const [status, code] of [[400, "process_rule"], [401, "permission_denied"], [403, "permission_denied"], [404, "not_found"], [409, "revision_changed"], [412, "revision_changed"], [429, "remote_failure"], [500, "remote_failure"], [302, "remote_failure"]] as const) {
    f.overrides.set("patch:1", { status, body: "server-secret" });
    const row = (await f.preview()).rows[0]!; assert.equal(row.code, code); assert.equal(row.decision, "refused"); assert.ok(row.remedy.length > 15);
  }
  f.items.clear(); const row = (await f.preview()).rows[0]!;
  assert.equal(row.code, "not_found"); assert.equal(row.rev, null); assert.equal(row.before, null); assert.equal(row.after, null);
  assert.equal(new MoveRefusal("revision_changed").exitCode, 4);
});

test("malformed batches and validation responses fail closed without response leakage", async (t) => {
  const f = await fixture(t);
  for (const transform of [
    (rows: AdoWorkItem[]) => [rows[0], rows[0]],
    (rows: AdoWorkItem[]) => [{ ...rows[0], id: 999 }],
    (rows: AdoWorkItem[]) => [{ ...rows[0], rev: 0 }],
    (rows: AdoWorkItem[]) => [{ ...rows[0], rev: 1.5 }],
    (rows: AdoWorkItem[]) => [{ ...rows[0], fields: null }],
    (rows: AdoWorkItem[]) => [{ ...rows[0], fields: {} }],
    (rows: AdoWorkItem[]) => [{ ...rows[0], relations: {} }],
    (rows: AdoWorkItem[]) => [{ ...rows[0], relations: [null] }],
    (rows: AdoWorkItem[]) => [{ ...rows[0], relations: [{ rel: 1, url: "x" }] }],
    (rows: AdoWorkItem[]) => [{ ...rows[0], relations: [{ rel: "Link", url: 1 }] }],
  ]) { f.transformBatch(transform); await refuses(f.preview(), "invalid_schema"); }
  f.transformBatch((rows) => rows);
  for (const body of ["invalid", "null", JSON.stringify(moveItem(2)), JSON.stringify(moveItem(1)), JSON.stringify({ id: 1, fields: null })]) {
    f.overrides.set("patch:1", { status: 200, body }); await refuses(f.preview(), "invalid_schema");
  }
  f.overrides.set("workitemsbatch", { status: 500, body: "server-secret" }); await refuses(f.preview(), "remote_failure");
  await refuses(simulateMove(f.config, async () => { throw new Error("server-secret"); }, f.options), "remote_failure");
  await refuses(f.preview({ expectedFingerprint: "0".repeat(64) }), "schema_changed");
});

test("maximum explicit backlog has bounded requests; relation fanout refuses without partial results", async (t) => {
  // The real SDK created this one seed; bounded in-memory projection avoids fifty unnecessary tracker writes.
  const f = await fixture(t);
  const items: ItemMetadata[] = Array.from({ length: 50 }, (_, index) => ({ ...f.options.items[0]!, id: `fixture-${String(index).padStart(2, "0")}`, ado_id: index + 1 }));
  for (let id = 1; id <= 50; id++) f.items.set(id, moveItem(id));
  f.items.get(1)!.relations = Array.from({ length: 200 }, (_, index) => ({ rel: "Custom.Link", url: `${f.config.orgUrl}/_apis/wit/workItems/${index + 51}` }));
  const result = await f.preview({ items, ids: items.map((item) => item.id) });
  assert.equal(result.rows.length, 50); assert.equal(result.requests, 56); assert.equal(result.relations.length, 200);
  assert.equal(f.calls.filter((call) => call.method === "PATCH").length, 50);
  f.items.get(1)!.relations = [...f.items.get(1)!.relations!, { rel: "Custom.Link", url: "https://example.invalid" }];
  await refuses(f.preview({ items, ids: items.map((item) => item.id) }), "budget_exceeded");
});

/** Install built output into a genuine non-git tracker and run the registered command through the host. */
async function host(t: test.TestContext) {
  const f = await fixture(t);
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const response = await f.request(req.method!, `${f.config.orgUrl}${req.url}`, chunks.length ? Buffer.concat(chunks).toString() : undefined,
      { Authorization: req.headers.authorization!, "Content-Type": req.headers["content-type"]! });
    res.writeHead(response.status, { "Content-Type": "application/json" }); res.end(response.body);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  f.config.orgUrl = `http://127.0.0.1:${address.port}`;
  installFixtureExtension(f.pmRoot);
  await f.pm.update(f.options.ids[0]!, { field: ["ado_id=1", `ado_org_url=${f.config.orgUrl}`, "ado_project=Example"] });
  const bin = join(f.root, "bin"); mkdirSync(bin); symlinkSync(process.execPath, join(bin, "node"));
  const env = { ...process.env, NODE_OPTIONS: relocateNodePreloads(process.env.NODE_OPTIONS ?? "", repo), ADO_ORG_URL: f.config.orgUrl, ADO_PROJECT: f.config.project, ADO_TOKEN: f.config.token, PM_AUTHOR: "fixture-agent", PM_NO_UPDATE_CHECK: "1", GIT_CEILING_DIRECTORIES: tmpdir(), PATH: bin };
  const harness = await createExtensionTestHarness(extension, { name: "pm-ado", capabilities: ["commands", "schema", "preflight"] });
  /** Invoke the actual registered handler with real SDK binding and restored process globals. */
  const command = async <Output = MovePreview & { code: string; exit_code: number }>(options: Record<string, unknown>, sdk = true,
    changes: Record<string, string | undefined> = {}, name = "ado move-preview") => {
    const previous = process.env, exit = process.exitCode; process.env = { ...env, ...changes };
    try { return (await harness.runCommand({ command: name, pmRoot: sdk ? f.pmRoot : undefined, options })).result as Output; }
    finally { process.env = previous; process.exitCode = exit; }
  };
  return { ...f, env, command, cli: (args: string[], command = "move-preview") => run(process.execPath, [join(repo, "node_modules/@unbrained/pm-cli/dist/cli.js"), "--pm-path", f.pmRoot, "ado", command, ...args], { cwd: f.root, env, maxBuffer: 8 * 1024 * 1024 }) };
}

test("installed no-git CLI and SDK command render compact JSON/TOON and preserve authoritative bytes", async (t) => {
  const f = await host(t); const before = snapshot(f.pmRoot);
  const options = { project: "Example", items: f.options.ids.join(","), areaPath: "Example\\New" };
  assert.equal((await f.command(options)).ok, true);
  const args = ["--project", "Example", "--items", options.items, "--area-path", "Example\\New"];
  const json = await f.cli([...args, "--json"]); const result = JSON.parse(json.stdout) as MovePreview;
  assert.equal(result.rows[0]!.decision, "allowed"); assert.equal(result.requests, 6);
  const toon = await f.cli([...args, "--output-format", "toon"]); assert.match(toon.stdout, /preview: true/u);
  assert.ok(Buffer.byteLength(json.stdout) < 2000); assert.ok(Buffer.byteLength(toon.stdout) < 2000);
  assert.deepEqual(snapshot(f.pmRoot), before);
  assert.ok(f.calls.every((call) => call.method !== "PATCH" || call.url.includes("validateOnly=true")));
  await assert.rejects(f.cli([...args, "--apply"]), /Unknown option/u);
});

/** Bypass host coercion to certify every raw string option at the exported boundary. */
test("direct move handler refuses non-string selections and guards with typed shell exits", async (t) => {
  const f = await host(t), before = snapshot(f.pmRoot);
  const previous = process.env, exit = process.exitCode;
  process.env = f.env;
  try {
    for (const name of ["project", "items", "areaPath", "iterationPath", "type", "expectFingerprint", "expect-fingerprint"]) {
      for (const value of [1, true]) {
        const result = await runMoveCommand({ command: "ado move-preview", args: [],
          options: { project: "Example", items: f.options.ids.join(","), areaPath: "Example\\New", [name]: value },
          global: {}, pm_root: f.pmRoot, sdk: createExtensionCommandSdk(f.pmRoot, f.pm) });
        assert.equal("code" in result && result.code, "configuration", `${name}: ${value}`);
        assert.equal("exit_code" in result && result.exit_code, 2);
        assert.equal(process.exitCode, 2);
        assert.ok("remedy" in result && result.remedy.length > 10);
      }
    }
  } finally { process.env = previous; process.exitCode = exit; }
  assert.equal(f.calls.length, 0);
  assert.deepEqual(snapshot(f.pmRoot), before);
});

test("host refuses malformed options, missing binding/credentials, schema drift and failed SDK reads", async (t) => {
  const f = await host(t), options = { project: "Example", items: f.options.ids.join(","), "iteration-path": "Example\\Release" };
  const before = snapshot(f.pmRoot);
  for (const changes of [{ project: undefined }, { items: undefined }, { project: " " }, { type: " " }]) {
    const refusal = await f.command({ ...options, ...changes });
    assert.equal(refusal.code, "configuration"); assert.equal(refusal.exit_code, 2);
  }
  const selection = await f.command({ ...options, items: "" });
  assert.equal(selection.code, "selection"); assert.equal(selection.exit_code, 2);
  const fingerprint = await f.command({ ...options, "expect-fingerprint": "bad" });
  assert.equal(fingerprint.code, "schema_changed"); assert.equal(fingerprint.exit_code, 4);
  assert.deepEqual(snapshot(f.pmRoot), before);
  assert.equal((await f.command(options, false)).code, "configuration");
  for (const changes of [{ ADO_ORG_URL: undefined }, { ADO_TOKEN: " " }]) assert.equal((await f.command(options, true, changes)).code, "configuration");
  assert.equal((await f.command({ ...options, "expect-fingerprint": "0".repeat(64) })).exit_code, 4);
  f.overrides.set("workitemsbatch", { status: 500, body: "server-secret" }); assert.equal((await f.command(options)).code, "remote_failure");
  f.overrides.clear(); assert.equal((await f.command(options)).ok, true);
  const file = fixtureItemPath(f.pmRoot, f.options.ids[0]!);
  // A genuine tracker read failure, not a mocked client, exercises sanitized fallback.
  writeFileSync(file, "invalid [tracker data");
  assert.equal((await f.command(options)).code, "remote_failure");
});


test("adversarial duplicate type metadata cannot exceed the total request budget", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 60; index++) f.types.push({ ...f.types[0]!, referenceName: `Custom.Task${index}` });
  await refuses(f.preview(), "remote_failure");
  assert.equal(f.calls.length, MOVE_LIMITS.requests);
  assert.ok(f.calls.every((call) => call.method === "GET"));
});

test("round-5 move IDs use host SDK prefix case and hash-marker normalization without a module link", async (t) => {
  const f = await host(t), id = f.options.ids[0]!;
  // The copied dist package under tracker storage has no SDK module link, so these
  // references must resolve through the installed no-module-link CLI, not the in-repo module.
  for (const project of ["Example", " Example "]) for (const reference of [id.toUpperCase(), ` #${id.toUpperCase()} `, id.slice("fixture-".length)]) {
    const json = await f.cli(["--project", project, "--items", reference, "--area-path", "Example\\New", "--json"]);
    const result = JSON.parse(json.stdout) as MovePreview;
    assert.equal(result.ok, true, json.stdout); assert.equal(result.rows[0]!.id, id);
  }
  const before = f.calls.length;
  const duplicate = await f.command({ project: "Example", items: `${id}, #${id.toUpperCase()}`, areaPath: "Example\\New" });
  assert.equal(duplicate.code, "selection"); assert.equal(f.calls.length, before);
});

test("round-7 move selection bounds and native lookup failures refuse before Azure reads", async (t) => {
  const f = await host(t), base = { project: "Example", areaPath: "Example\\New" };
  assert.equal((await f.command({ ...base, items: Array.from({ length: 51 }, (_, index) => "fixture-" + index).join(",") })).code, "selection");
  assert.equal((await f.command({ ...base, items: "fixture-missing" })).code, "selection");
  assert.equal((await f.command({ ...base, items: "," })).code, "selection");
  assert.equal(f.calls.length, 0);
});

test("blank move selection tokens refuse before any SDK lookup", async (t) => {
  const f = await host(t);
  const sdk = (await import("@unbrained/pm-cli/sdk")).createExtensionCommandSdk(f.pmRoot, f.pm);
  const get = t.mock.method(f.pm, "get", () => { throw new Error("unexpected SDK lookup"); });
  const list = t.mock.method(f.pm, "listAllComplete", () => { throw new Error("unexpected SDK snapshot"); });
  const previous = process.env, exit = process.exitCode;
  process.env = { ...f.env };
  try {
    for (const items of [",", "a,b,", "a,,b", " ", "a, ,b", ""]) {
      const { runMoveCommand } = await import("../moves.ts");
      const result = await runMoveCommand({ command: "ado move-preview", args: [], global: {}, pm_root: f.pmRoot, sdk,
        options: { project: "Example", items, areaPath: "Example\\New" } });
      assert.equal("code" in result && result.code, "selection", JSON.stringify(result));
      assert.equal("exit_code" in result && result.exit_code, 2);
    }
    assert.equal(get.mock.callCount(), 0);
    assert.equal(list.mock.callCount(), 0);
    assert.equal(f.calls.length, 0);
  } finally { process.env = previous; process.exitCode = exit; }
});

test("SDK move lookup failures return sanitized remote refusals", async (t) => {
  const f = await host(t);
  const lookup = t.mock.method(PmClient.prototype, "get", async () => { throw new Error("lookup-secret"); });
  const result = await f.command({ project: "Example", items: f.options.ids[0], areaPath: "Example\\New" });
  assert.equal(result.code, "remote_failure");
  assert.equal(result.exit_code, 3);
  assert.doesNotMatch(JSON.stringify(result), /lookup-secret/u);
  assert.equal(lookup.mock.callCount(), 1);
  assert.equal(f.calls.length, 0);
});

test("round-7 unscoped duplicate Azure IDs cannot borrow a selected native record's scope", async (t) => {
  const f = await fixture(t), first = f.options.items[0]!;
  for (const missing of [{ ado_org_url: undefined }, { ado_project: undefined }]) {
    const result = await f.preview({ items: [first, { ...first, id: "fixture-unscoped", ...missing }] });
    assert.equal(result.rows.length, 1); assert.equal(result.rows[0]!.id, first.id);
    assert.equal(result.ok, true);
  }
});

/** Use the existing move REST service and an installed no-git SDK tracker for artifact reads. */
test("artifact plan returns deterministic PR/build coordinates through the SDK and installed CLI", async (t) => {
  const f = await host(t);
  const id = f.options.ids[0]!;
  const projectId = "01234567-89ab-cdef-0123-456789abcdef";
  const repositoryId = "12345678-90ab-cdef-0123-456789abcdef";
  const pull = "vstfs:///Git/PullRequestId/";
  const build = "vstfs:///Build/Build/";
  const remote = f.items.get(1)!;
  remote.fields["System.Description"] = "private-body";
  remote.relations = [
    { rel: "ArtifactLink", url: `${pull}${projectId.toUpperCase()}%2F${repositoryId}%2f17`, attributes: { comment: "private-comment" } },
    { rel: "ArtifactLink", url: `${pull}${projectId}/${repositoryId}/17` },
    { rel: "ArtifactLink", url: `${build}8`, attributes: { name: "Integrated in build" } },
    { rel: "ArtifactLink", url: `${build}10`, attributes: { name: "Found in build" } },
    { rel: "ArtifactLink", url: `${build}9` },
    { rel: "Hyperlink", url: "https://example.invalid/private-link" },
  ];
  const before = snapshot(f.pmRoot);
  const remoteBefore = structuredClone(remote);
  const args = ["--items", id];
  const expected: ArtifactPlan = {
    ok: true, complete: true, rows: [{
      pm_id: id, ado_id: 1, rev: remote.rev, links: [
        { kind: "build", id: 9 },
        { kind: "found_in_build", id: 10 },
        { kind: "integrated_in_build", id: 8 },
        { kind: "pull_request", project_id: projectId, repository_id: repositoryId, id: 17 },
      ], omitted_links: 0, unsupported_links: 0, invalid_links: 0,
    }],
  };
  assert.deepEqual(await observeArtifactPlan(f.pm, f.config, f.request, [id]), expected);
  f.transformBatch((rows) => rows.map((row) => ({ ...row, relations: [...row.relations!].reverse() })));
  const json = await f.cli([...args, "--json"], "artifact-plan");
  assert.deepEqual(JSON.parse(json.stdout), expected);
  assert.deepEqual(await f.command<ArtifactPlan>({ items: ` ${id} ` }, true, {}, "ado artifact-plan"), expected);
  const toon = await f.cli([...args, "--output-format", "toon"], "artifact-plan");
  assert.match(toon.stdout, /complete: true/u);
  for (const output of [json.stdout, toon.stdout]) {
    assert.ok(Buffer.byteLength(output) < 1800);
    assert.doesNotMatch(output, /private-|synthetic-move-token|vstfs:\/\//u);
  }
  assert.deepEqual(snapshot(f.pmRoot), before);
  assert.deepEqual(remote, remoteBefore);
  assert.equal(f.calls.length, 4);
  for (const call of f.calls) {
    assert.equal(call.method, "POST");
    assert.match(call.url, /workitemsbatch\?api-version=7\.1$/u);
    assert.deepEqual(call.body, { ids: [1], $expand: "relations", errorPolicy: "omit" });
  }
});

test("artifact plan accounts for omitted rows, capped output, and opaque or malformed relations", async (t) => {
  const f = await host(t);
  const id = f.options.ids[0]!;
  const { item: { id: missing } } = await f.pm.create({ title: "Omitted fixture", type: "Task", field: [
    "ado_id=2", `ado_org_url=${f.config.orgUrl}`, "ado_project=Example",
  ] });
  const remote = f.items.get(1)!;
  const guid = "01234567-89ab-cdef-0123-456789abcdef";
  const urls = [
    "vstfs:///Git/Commit/opaque",
    "vstfs:///Git/PullRequestId/malformed",
    `vstfs:///Git/PullRequestId/${guid}/${guid}/2147483648`,
    "vstfs:///Build/Build/2147483648",
    "vstfs:///Build/Build/10?injected=private",
    undefined,
  ];
  remote.relations = [
    ...Array.from({ length: ARTIFACT_LIMITS.linksPerItem + 1 }, (_, index) => ({ rel: "ArtifactLink", url: `vstfs:///Build/Build/${index + 1}` })),
    ...urls.map((url) => ({ rel: "ArtifactLink", url: url as string })),
    null as unknown as NonNullable<AdoWorkItem["relations"]>[number],
  ];
  const before = snapshot(f.pmRoot);
  const plan = await observeArtifactPlan(f.pm, f.config, f.request, [missing, id]);
  assert.equal(plan.complete, false);
  assert.deepEqual(plan.rows.map((row) => row.pm_id), [id, missing].sort());
  const observed = plan.rows.find((row) => row.pm_id === id)!;
  assert.deepEqual(observed.links.map((link) => link.id), Array.from({ length: ARTIFACT_LIMITS.linksPerItem }, (_, index) => index + 1));
  assert.deepEqual([observed.omitted_links, observed.unsupported_links, observed.invalid_links], [1, 1, 6]);
  assert.deepEqual(plan.rows.find((row) => row.pm_id === missing), {
    pm_id: missing, ado_id: 2, rev: null, links: [], omitted_links: 0, unsupported_links: 0, invalid_links: 0,
  });
  assert.deepEqual(f.calls.map((call) => call.body), [{ ids: [1, 2], $expand: "relations", errorPolicy: "omit" }]);

  f.transformBatch((rows) => rows.map(({ relations: _, ...row }) => row));
  const empty = await observeArtifactPlan(f.pm, f.config, f.request, [id]);
  assert.equal(empty.complete, true);
  assert.deepEqual(empty.rows[0]?.links, []);
  assert.deepEqual(snapshot(f.pmRoot), before);
});

test("artifact plan refuses ambiguous scope and sanitizes malformed batches and remote failures", async (t) => {
  const f = await host(t);
  const id = f.options.ids[0]!;
  const observe = (ids = [id]) => observeArtifactPlan(f.pm, f.config, f.request, ids);
  const selection = { name: "ArtifactRefusal", code: "selection", exitCode: 2 };
  const unavailable = { name: "ArtifactRefusal", code: "read_failure", exitCode: 3 };
  for (const ids of [[], Array.from({ length: ARTIFACT_LIMITS.items + 1 }, (_, index) => `fixture-${index}`), [id, id], [""], ["fixture-missing"]]) {
    await assert.rejects(observe(ids), selection);
  }
  const { item: { id: foreign } } = await f.pm.create({ title: "Foreign fixture", type: "Task", field: [
    "ado_id=1", `ado_org_url=${f.config.orgUrl}`, "ado_project=Other",
  ] });
  const { item: { id: unlinked } } = await f.pm.create({ title: "Unlinked fixture", type: "Task" });
  await assert.rejects(observe([foreign]), selection);
  await assert.rejects(observe([unlinked]), selection);
  assert.equal(f.calls.length, 0);
  f.transformBatch((rows) => [...rows, rows[0]!]);
  await assert.rejects(observe(), unavailable);
  for (const change of [{ id: 2 }, { rev: 0 }, { fields: undefined }, { fields: { "System.TeamProject": "Other" } }, { relations: null }]) {
    f.transformBatch((rows) => [{ ...rows[0]!, ...change }]);
    await assert.rejects(observe(), unavailable);
  }
  f.transformBatch(() => undefined);
  await assert.rejects(observe(), unavailable);

  f.overrides.set("workitemsbatch", { status: 403, body: "private-remote-response" });
  await assert.rejects(observe(), (error: unknown) => {
    assert.ok(error instanceof ArtifactRefusal);
    assert.equal(error.code, "read_failure");
    assert.doesNotMatch(error.message, /private-|synthetic-move-token/u);
    return true;
  });
  await assert.rejects(f.cli(["--items", id, "--json"], "artifact-plan"), (error: { code: number; stdout: string; stderr: string }) => {
    assert.equal(error.code, 3);
    assert.equal(JSON.parse(error.stdout).code, "read_failure");
    assert.doesNotMatch(error.stdout + error.stderr, /private-|synthetic-move-token/u);
    return true;
  });
  await assert.rejects(f.cli(["--json"], "artifact-plan"), (error: { code: number; stdout: string }) => {
    assert.equal(error.code, 2);
    assert.equal(JSON.parse(error.stdout).code, "configuration");
    return true;
  });

  await f.pm.create({ title: "Duplicate fixture", type: "Task", field: [
    "ado_id=1", `ado_org_url=${f.config.orgUrl}`, "ado_project=Example",
  ] });
  const calls = f.calls.length;
  await assert.rejects(observe(), selection);
  const command = (options: Record<string, unknown>, sdk = true, changes = {}) =>
    f.command(options, sdk, changes, "ado artifact-plan");
  assert.equal((await command({ items: id }, false)).code, "configuration");
  assert.equal((await command({ items: id }, true, { ADO_TOKEN: "" })).code, "configuration");
  assert.equal((await command({})).code, "configuration");
  assert.equal((await command({ items: 42 })).code, "selection");
  assert.equal((await command({ items: id })).code, "selection");
  assert.equal(f.calls.length, calls);
});
