import { readOnlyTracker } from "./helpers/readonly-tracker.ts";
import { authoritativeDigest } from "./helpers/authoritative-digest.ts";
/** Measure a read-only public tracker copy and clearly labeled in-memory Azure evidence. */
import assert from "node:assert/strict";
import { compileRefreshPlan, observeRefreshPlan, type RefreshField } from "../index.ts";
const { pmRoot, before, pm } = readOnlyTracker(process.argv[2]!);
const { items } = await pm.listAllComplete();
const needs: RefreshField[] = ["title", "description", "status", "priority", "tags", "assignee", "ado_area_path", "ado_iteration_path", "relations"];
const config = { orgUrl: "https://dev.azure.com/example", project: "Example", token: "synthetic-token" };
const raw = await observeRefreshPlan(pm, config, async () => { throw new Error("Public tracker has no Azure links; network must stay unused"); }, needs);
assert.equal(raw.cost.probe_reads, 0);
const saved = items.map((_item, index) => ({ id: index + 1, revision: 7, base: [...needs] }));
const start = performance.now();
const same = compileRefreshPlan({ needs, saved, observed: saved.map((row) => ({ id: row.id, revision: 7 })) });
const changed = compileRefreshPlan({ needs, saved, observed: saved.map((row) => ({ id: row.id, revision: 8 })) });
const mixed = compileRefreshPlan({ needs, saved, observed: saved.filter((_row, index) => index % 5 !== 0).map((row) => ({ id: row.id, revision: row.id % 3 === 0 ? 8 : 7 })) });
assert.equal(same.cost.hydrate_reads, 0);
assert.deepEqual(authoritativeDigest(pmRoot), before);
assert.deepEqual((await pm.listAllComplete()).items, items);
console.log(JSON.stringify({ tracker_items: items.length, authoritative_files: Object.keys(before).length,
  raw_unlinked: raw.skipped, projected_same: same.cost, projected_changed: changed.cost,
  projected_mixed: { ...mixed.cost, unchanged: mixed.unchanged.length, changed: mixed.changed.length, unavailable: mixed.unavailable.length },
  elapsed_ms: Math.round(performance.now() - start), json_bytes: { same: Buffer.byteLength(JSON.stringify(same)), changed: Buffer.byteLength(JSON.stringify(changed)), mixed: Buffer.byteLength(JSON.stringify(mixed)) },
  sdk_state_equal: true, authoritative_hashes_equal: true, live_azure: false }, null, 2));
