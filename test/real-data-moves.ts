import { readOnlyTracker } from "./helpers/readonly-tracker.ts";
import { authoritativeDigest } from "./helpers/authoritative-digest.ts";
/** Reproduce public-tracker measurements on an exported, non-git copy without pm mutations. */
import assert from "node:assert/strict";
import { MoveRefusal, RELATION_MAP, simulateMove } from "../index.ts";
import { moveItem, moveService } from "./fixtures/move-service.ts";

const { pmRoot, before, pm } = readOnlyTracker(process.argv[2]!);
const snapshot = await pm.listAllComplete();
const original = [...snapshot.items].sort((a, b) => a.id < b.id ? -1 : Number(a.id > b.id));
assert.ok(original.length > 0 && original.length <= 50);
const service = moveService(original.map((item, index) => moveItem(index + 1, {
  "System.AreaPath": index % 5 === 0 ? "Example\\Locked\\Child" : "Example\\Old",
  "Custom.Ready": item.status !== "closed",
})));
service.deniedAreas.add("Example\\Locked");
// Public fleet data has no Azure provenance. The untouched selection must refuse without network access.
let rawRefusal = "";
try {
  await simulateMove(service.config, service.request, { items: original, ids: original.map((item) => item.id), iterationPath: "Example\\Release" });
} catch (error) { assert.ok(error instanceof MoveRefusal); rawRefusal = error.code; }
assert.equal(rawRefusal, "selection"); assert.equal(service.calls.length, 0);
// Project the real public identities, lifecycle states and direct relations into a synthetic Azure project.
// These links exist only in memory and do not claim live Azure acceptance.
const projected = original.map((item, index) => ({ ...item, ado_id: index + 1, ado_org_url: service.config.orgUrl, ado_project: service.config.project }));
const byId = new Map(projected.map((item) => [item.id, item.ado_id]));
for (const item of projected) {
  const dependencies = [...(item.dependencies ?? [])];
  if (item.parent) dependencies.push({ id: item.parent, kind: "parent" });
  service.items.get(item.ado_id)!.relations = dependencies.flatMap((dep) => {
    const target = byId.get(dep.id), rel = Object.entries(RELATION_MAP).find(([, kind]) => kind === dep.kind)?.[0];
    return target && rel ? [{ rel, url: `${service.config.orgUrl}/_apis/wit/workItems/${target}` }] : [];
  });
}
const remoteBefore = JSON.stringify([...service.items]);
const options = { items: projected, ids: projected.map((item) => item.id), areaPath: "Example\\Delivery", iterationPath: "Example\\Release" };
const start = performance.now();
const result = await simulateMove(service.config, service.request, options);
const elapsed = Math.round(performance.now() - start);
assert.deepEqual(await simulateMove(service.config, service.request, { ...options, ids: [...options.ids].reverse() }), result);
assert.equal(JSON.stringify([...service.items]), remoteBefore);
assert.deepEqual(authoritativeDigest(pmRoot), before);
console.log(JSON.stringify({
  source: "unbraind/pm-ado", source_head: process.argv[3], source_items: original.length,
  authoritative_files: Object.keys(before).length, authoritative_files_changed: 0,
  unlinked_refusal: rawRefusal, unlinked_requests: 0,
  projected_items: result.rows.length, allowed: result.rows.filter((row) => row.decision === "allowed").length,
  inherited_denials: result.rows.filter((row) => row.code === "permission_denied").length,
  iteration_rule_refusals: result.rows.filter((row) => row.code === "process_rule").length,
  direct_relations: result.relations.length,
  relation_boundaries_changed: result.relations.filter((edge) => JSON.stringify(edge.before) !== JSON.stringify(edge.after)).length,
  requests_per_preview: result.requests, deterministic_replay: true,
  remote_items_changed: 0, elapsed_ms: elapsed, json_bytes: Buffer.byteLength(JSON.stringify(result)),
  live_azure: false,
}, null, 2));
