/** SDK-oracle field normalization over real non-git native trackers. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as sdk from "@unbrained/pm-cli/sdk";
import { normalizeStatusValue, normalizeItemReference, normalizeTitleValue, normalizeAssigneeValue,
  normalizeTagValues, normalizePriorityValue, normalizeLiteralValue, normalizeScopeValue, normalizeFieldValues, normalizeStateMaps,
  type ValueNormalization } from "../normalization.ts";
import { localValues, remoteValues, azureFields, IMPORT_STATE_MAP } from "../sync.ts";

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
});
