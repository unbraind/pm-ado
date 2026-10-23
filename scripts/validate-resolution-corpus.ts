/** Measure conflict decision coordinates on an unchanged public tracker copy, without Azure credentials. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { STATE_MAP, type AdoWorkItem, type ResolutionPlan, resolutionDigest, resolutionFields, validateResolutionPlan } from "../index.ts";
import { ADO_FIELD_MAP, IMPORT_STATE_MAP, azureFields, localValues } from "../sync.ts";

/** Fingerprint every copied source file; SDK-derived caches are excluded from this evidence. */
async function fingerprint(root: string, prefix = ""): Promise<string> {
  const hash = createHash("sha256");
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || entry.name === "runtime" || entry.name === "locks") continue;
    const relative = join(prefix, entry.name);
    hash.update(relative);
    hash.update(entry.isDirectory() ? await fingerprint(root, relative) : await readFile(join(root, relative)));
  }
  return hash.digest("hex");
}

const root = resolve(process.argv[2]);
const before = await fingerprint(root);
const pm = new PmClient({ pmRoot: root, cwd: resolve(root, "../.."), author: "fixture-agent" });
const snapshot = await pm.listAllComplete();
const { items } = snapshot;
const template = JSON.parse(await readFile(new URL("../test/fixtures/resolutions/revision-2.json", import.meta.url), "utf8")) as AdoWorkItem;
const maps = { imports: IMPORT_STATE_MAP, exports: { ...STATE_MAP, canceled: "Removed" } };
let fields = 0, conflicts = 0, refused = 0, bytes = 0;
for (const [index, source] of items.entries()) {
  const values = localValues(source);
  const base = { ...values, title: "Synthetic common base" };
  // Overlay only in memory: public tracker bytes stay unchanged throughout this run.
  const item = { ...source, ado_sync_base: JSON.stringify(base) };
  const remote = { ...structuredClone(template), id: index + 1,
    fields: { ...template.fields, ...azureFields(values, Object.keys(ADO_FIELD_MAP), maps.exports), "System.Title": "Synthetic remote conflict" } };
  const rows = resolutionFields(item, remote, maps);
  const plan: ResolutionPlan = { schema: "pm-ado/resolution/1", scope: { org: "https://dev.azure.com/example", project: "Project" },
    local: { id: item.id, revision: resolutionDigest({ metadata: item, body: "" }) },
    remote: { id: remote.id, revision: remote.rev, digest: resolutionDigest(remote) }, fields: rows,
    mapping: resolutionDigest(maps), choices: rows.filter((field) => field.local !== field.remote).map(({ field }) => ({ field, take: "local" })) };
  validateResolutionPlan(plan);
  assert.throws(() => validateResolutionPlan({ ...plan, choices: [] }), { code: "invalid_choices" });
  fields += rows.length; conflicts += rows.filter((field) => field.conflict).length;
  refused++; bytes += Buffer.byteLength(JSON.stringify(plan));
}
assert.equal(await fingerprint(root), before, "public tracker source files must remain unchanged");
console.log(JSON.stringify({ items: items.length, certified: snapshot.complete_list.item_count === items.length, fields, conflicts, valid_plans: items.length,
  incomplete_choice_refusals: refused, mean_json_bytes: Math.round(bytes / items.length), tracker_unchanged: true, azure_writes: 0,
  fixture_api_version: "7.1", canceled_state_override: "Removed" }, null, 2));
