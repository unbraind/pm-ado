/** SDK-oracle field normalization over real non-git native trackers. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as sdk from "@unbrained/pm-cli/sdk";
import { normalizeStatusValue, normalizeItemReference, normalizeTitleValue, normalizeAssigneeValue,
  normalizeTagValues, normalizePriorityValue, normalizeLiteralValue, normalizeScopeValue, normalizeFieldValues, normalizeStateMaps,
  sameScope, normalizeDiscoveryFieldValues, type ValueNormalization } from "../normalization.ts";
import { localValues, remoteValues, azureFields, remoteScalarValues, IMPORT_STATE_MAP, stateMap, type Values } from "../sync.ts";

/** Obtain the registry and native write oracle without mocking SDK functions. */
async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "ado-normalizers-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pmRoot = join(root, ".agents/pm"), pm = new sdk.PmClient({ cwd: root, pmRoot, author: "fixture-agent" });
  await pm.run("init", { prefix: "probe" });
  const { item } = await pm.create({ title: "Normalization oracle", type: "Task" });
  const settings = await sdk.readSettings(pmRoot);
  const context: ValueNormalization = { sdk, schema: settings.schema, idPrefix: settings.id_prefix };
  return { pm, item, context, root };
}

test("round-5 every registry status spelling shares the native SDK normalizer and preserves unknown legacy values", async (t) => {
  const f = await fixture(t), registry = sdk.resolveRuntimeStatusRegistry(f.context.schema);
  let spellings = 0;
  for (const [alias, canonical] of registry.alias_to_id) for (const spelling of [alias, alias.toUpperCase(), ` \t${alias}\u00a0`, alias.replaceAll("_", "-")]) {
    if (sdk.normalizeStatusInput(spelling, registry) !== canonical) continue;
    assert.equal(normalizeStatusValue(spelling, f.context), canonical); spellings++;
  }
  assert.ok(spellings > registry.alias_to_id.size);
  for (const legacy of ["historical_stage", "constructor", "__proto__", " 未知 "]) assert.equal(normalizeStatusValue(legacy, f.context), legacy);
  assert.equal(normalizeStatusValue(" CLOSED "), "closed");
  assert.equal(normalizeStatusValue("historical_stage"), "historical_stage");
  for (const id of [f.item.id.toUpperCase(), ` #${f.item.id.toUpperCase()} `, f.item.id.slice("probe-".length)]) assert.equal(normalizeItemReference(id, f.context), f.item.id);
  assert.equal(normalizeItemReference(` #${f.item.id.toUpperCase()} `), f.item.id);
  t.diagnostic(`${spellings} SDK-accepted spellings, all declared aliases and unchanged unknown legacy statuses`);
});

test("round-5 field normalizers match native writes without erasing literal Unicode, whitespace or legacy data", async (t) => {
  const f = await fixture(t);
  for (const text of [" \tMixed CASE\u00a0", "Café", "Cafe\u0301", "none", " NULL ", ""]) {
    const title = text.trim() || "Empty optional fields";
    await f.pm.update(f.item.id, { title, description: text, ...(text.trim() ? { assignee: text } : { unset: ["assignee"] }), tags: JSON.stringify([" ä ", "Z", "z", "none"]) });
    const item = (await f.pm.listAllComplete()).items.find((row) => row.id === f.item.id)!;
    assert.equal(normalizeTitleValue(title, f.context), item.title);
    assert.equal(normalizeLiteralValue(text), item.description ?? "");
    assert.equal(normalizeAssigneeValue(text, f.context), item.assignee ?? "");
    assert.deepEqual(normalizeTagValues([" ä ", "Z", "z", "none"], f.context), [...(item.tags ?? [])].sort());
    assert.equal(normalizeLiteralValue(text), text);
  }
  assert.equal(normalizeTitleValue(" "), "");
  assert.equal(normalizeTitleValue(7 as unknown as string), "", "legacy non-text runtime values retain the previous empty projection");
  assert.equal(normalizeAssigneeValue(" Name "), "Name");
  assert.deepEqual(normalizeTagValues(["Z", " z "]), ["z"]);
  assert.equal(normalizePriorityValue(" 3 ", f.context), 3);
  assert.equal(normalizePriorityValue(2), 2);
  assert.equal(normalizePriorityValue("historical"), "historical");
  assert.equal(normalizePriorityValue(7), 7); assert.equal(normalizePriorityValue(-1), -1);
  assert.equal(normalizePriorityValue(" "), 0);
  assert.deepEqual(normalizeFieldValues({}), {});
  assert.equal(normalizeScopeValue(" P "), "P"); assert.equal(normalizeScopeValue(" https://fixture.invalid/org/// ", true), "https://fixture.invalid/org");
  const original = { status: " CLOSED ", title: " Title ", description: "none", assignee: " null ", tags: ["X", "x"], priority: "2", ado_area_path: " P\\A ", ado_iteration_path: " P\\I ", ado_base_partial: 1, ado_agreed_revisions: "{}", unknown: 7 };
  const normalized = normalizeFieldValues(original, f.context);
  assert.deepEqual(normalized, { ...original, status: "closed", title: "Title", description: "none", assignee: "", tags: ["x"], priority: 2 });
  assert.deepEqual(normalizeFieldValues({ status: 7, title: 7, description: 7, assignee: 7, tags: "old", priority: ["old"], ado_area_path: 7 }), { status: 7, title: 7, description: 7, assignee: 7, tags: "old", priority: ["old"], ado_area_path: 7 });
  const maps = normalizeStateMaps({ imports: JSON.parse('{"constructor":"CLOSED","__proto__":"OPEN"}'), exports: JSON.parse('{"CLOSED":"Done","constructor":"Constructor"}') }, f.context);
  assert.equal(maps.imports.constructor, "closed"); assert.equal(maps.imports.__proto__, "open"); assert.equal(maps.exports.closed, "Done");
  assert.equal(maps.exports.constructor, "Constructor");
  for (const key of ["constructor", "__proto__", "not_a_field"]) assert.throws(() => azureFields({}, [key], {}), /Unknown mapped field/u);
  for (const [key, value] of Object.entries(localValues((await f.pm.listAllComplete()).items.find((row) => row.id === f.item.id)!, f.context))) if (key !== "status") assert.ok(Object.hasOwn(azureFields({ [key]: value }, [key], {}, f.context), key === "title" ? "System.Title" : key === "description" ? "System.Description" : key === "tags" ? "System.Tags" : key === "priority" ? "Microsoft.VSTS.Common.Priority" : key === "assignee" ? "System.AssignedTo" : key === "ado_area_path" ? "System.AreaPath" : "System.IterationPath"));
  assert.throws(() => remoteValues({ id: 1, rev: 1, fields: { "System.State": "constructor" } }, IMPORT_STATE_MAP, f.context), /Unmapped/u);
  const remote = { id: 1, rev: 1, fields: { "System.State": "Done" } }, imports = { Done: " CLOSED " };
  const preferredCases: (Values | undefined)[] = [undefined, {}, { status: 1 }, { status: " CLOSED " }];
  for (const preferred of preferredCases) assert.equal(remoteScalarValues(remote, preferred, imports, { closed: "Closed" }, f.context).status, "closed");
  assert.equal(remoteScalarValues(remote, undefined, imports, {}, false).status, " CLOSED ");
});

test("sameScope normalizes both scope fields and states how a missing organization is treated", () => {
  // CodeRabbit on #46: refresh, moves, resolution and sync each repeated this comparison. One helper keeps the rules
  // together, and the single intended difference (legacy items without ado_org_url) is an explicit argument.
  const config = { orgUrl: "https://dev.azure.com/acme/", project: " Platform " };
  assert.equal(sameScope({ ado_org_url: " https://dev.azure.com/acme ", ado_project: "Platform" }, config, "refuse"), true);
  assert.equal(sameScope({ ado_org_url: "https://dev.azure.com/other", ado_project: "Platform" }, config, "refuse"), false);
  assert.equal(sameScope({ ado_org_url: "https://dev.azure.com/acme", ado_project: "Other" }, config, "refuse"), false);
  assert.equal(sameScope({ ado_project: "Platform" }, config, "refuse"), false, "refuse requires a stored organization");
  assert.equal(sameScope({ ado_project: "Platform" }, config, "match"), true, "match accepts a legacy item without one");
  assert.equal(sameScope({ ado_org_url: "https://dev.azure.com/other", ado_project: "Platform" }, config, "match"), false);
  assert.equal(sameScope({ ado_project: "Other" }, config, "match"), false, "the project is compared in both modes");
});

test("state-map canonicalization refuses ambiguous duplicate export keys instead of discarding one", () => {
  const resolve = (value: string) => value.trim().toLowerCase();
  // Two spellings of one status that map to different Azure states are ambiguous; refusing
  // beats silently keeping whichever entry Object.fromEntries happened to visit last.
  assert.throws(() => normalizeStateMaps({ imports: {}, exports: { "todo": "New", " TODO ": "Proposed" } }, { resolveStatus: resolve }),
    /Ambiguous status export mapping for todo/u);
  assert.throws(() => normalizeStateMaps({ imports: {}, exports: { "todo": "New", "TODO": "Proposed" } }, { resolveStatus: resolve }),
    /Ambiguous status export mapping for todo/u);
  // Identical targets are unambiguous and collapse to one canonical mapping.
  assert.deepEqual(normalizeStateMaps({ imports: {}, exports: { "todo": "New", " TODO ": "New" } }, { resolveStatus: resolve }),
    { imports: {}, exports: { todo: "New" } });
  assert.deepEqual(normalizeStateMaps({ imports: {}, exports: { "todo": "New", "other": "Proposed" } }, { resolveStatus: resolve }),
    { imports: {}, exports: { todo: "New", other: "Proposed" } });
});


test("discovery scalar projection matches the SDK writer with and without a module context", async (t) => {
  const f = await fixture(t);
  for (const priority of [" 3 ", "historical", -1, 7]) {
    const values = { title: " Title ", status: " OPEN ", priority, assignee: " NULL ", tags: [" Z ", "z", " ä ", ""], description: " Literal ", ado_area_path: " Area " };
    const expected = normalizeFieldValues(values, f.context);
    assert.deepEqual(normalizeDiscoveryFieldValues(values, f.context), expected);
    assert.deepEqual(normalizeDiscoveryFieldValues(values, { resolveStatus: (value) => normalizeStatusValue(value, f.context) }), expected);
    assert.deepEqual(normalizeDiscoveryFieldValues(values), expected);
  }
  assert.deepEqual(normalizeDiscoveryFieldValues({ assignee: " Name " }, { resolveStatus: (value) => value }), { assignee: "Name" });
  const maps = normalizeStateMaps({ imports: {}, exports: JSON.parse('{"__proto__":"New"}') }, { resolveStatus: (value) => value });
  assert.equal(Object.hasOwn(maps.exports, "__proto__"), true);
  assert.equal(maps.exports.__proto__, "New");
});


test("explicit canonical status overrides replace defaults while collisions within one layer refuse", () => {
  const normalization = { resolveStatus: (value: string) => value.trim().toLowerCase() };
  assert.deepEqual(stateMap('{" CLOSED ":"Done"}', { open: "New", closed: "Closed" }, normalization), { open: "New", closed: "Done" });
  assert.deepEqual(stateMap(undefined, { " CLOSED ": "Closed" }, normalization), { closed: "Closed" });
  assert.throws(() => stateMap('{"closed":"Done"," CLOSED ":"Closed"}', { open: "New" }, normalization), /Ambiguous status export mapping/u);
  assert.throws(() => stateMap(undefined, { closed: "Done", " CLOSED ": "Closed" }, normalization), /Ambiguous status export mapping/u);
});
