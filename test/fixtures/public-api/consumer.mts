/** This fixture uses the published five-argument constructor and optional legacy forms only. */
import assert from "node:assert/strict";
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sdk from "@unbrained/pm-cli/sdk";
import { AdoClient, AdoResolutionService, batchIds, validateResolutionPlan } from "pm-ado";
import { loadResolutionSdk } from "pm-ado/dist/resolution.js";


import * as publicApi from "pm-ado";
import type { AdoConfig, AdoRelation, AdoTransport, AdoWorkItem, BatchReadResult, ContractField, ContractIssue, ContractOptions, ContractRefusalCode, ContractRelation, ContractType, CustomRelationMap, JsonPatchOperation, MoveOptions, MovePreview, MoveRefusalCode, MoveRelation, MoveRow, MoveScope, ProjectContract, RelationDiagnostic, RelationIdentities, RelationKind, ResolutionChoice, ResolutionField, ResolutionIntent, ResolutionMaps, ResolutionObserver, ResolutionPlan, ResolutionReceipt, ResolutionRefusalCode, UnmappedPmRelation } from "pm-ado";
export type PublishedTypeNames = [AdoConfig, AdoRelation, AdoTransport, AdoWorkItem, BatchReadResult, ContractField, ContractIssue, ContractOptions, ContractRefusalCode, ContractRelation, ContractType, CustomRelationMap, JsonPatchOperation, MoveOptions, MovePreview, MoveRefusalCode, MoveRelation, MoveRow, MoveScope, ProjectContract, RelationDiagnostic, RelationIdentities, RelationKind, ResolutionChoice, ResolutionField, ResolutionIntent, ResolutionMaps, ResolutionObserver, ResolutionPlan, ResolutionReceipt, ResolutionRefusalCode, UnmappedPmRelation];

assert.equal(AdoResolutionService.length, 5);
assert.equal(AdoClient.prototype.getWorkItemsReport.length, 1);
assert.equal(loadResolutionSdk.length, 0);

const root = process.argv[2]!;
const pmRoot = join(root, ".agents/pm");
const pm = new sdk.PmClient({ cwd: root, pmRoot, author: "fixture-agent" });
await pm.run("init", { prefix: "fixture" });
const packageRoot = dirname(dirname(fileURLToPath(import.meta.resolve("pm-ado"))));
const installed = join(pmRoot, "extensions/pm-ado");
mkdirSync(installed, { recursive: true });
cpSync(join(packageRoot, "dist"), join(installed, "dist"), { recursive: true });
cpSync(join(packageRoot, "manifest.json"), join(installed, "manifest.json"));
const config: AdoConfig = { orgUrl: "https://dev.azure.com/example", project: "Example", token: "synthetic-token" };
const request: AdoTransport = async () => ({ status: 200, body: JSON.stringify({ value: [{ id: 1, rev: 1, relations: [], fields: {
  "System.Title": "Published consumer", "System.State": "New", "System.WorkItemType": "Task", "Microsoft.VSTS.Common.Priority": 2,
} }] }) });
const azure = new AdoClient(config, request);
const { item } = await pm.create({ title: "Published consumer", type: "Task", field: ["ado_id=1", "ado_rev=1", `ado_org_url=${config.orgUrl}`, "ado_project=Example"] });
const observer: ResolutionObserver = () => {};
const services = [
  new AdoResolutionService(pmRoot, "fixture-agent", pm, azure, config),
  new AdoResolutionService(pmRoot, "fixture-agent", pm, azure, config, undefined),
  new AdoResolutionService(pmRoot, "fixture-agent", pm, azure, config, sdk),
  new AdoResolutionService(pmRoot, "fixture-agent", pm, azure, config, sdk, observer),
  new AdoResolutionService(pmRoot, "fixture-agent", pm, azure, config, undefined, observer),
];
for (const service of services) {
  const plan = await service.plan(item.id);
  validateResolutionPlan(plan);
  assert.equal(plan.local.id, item.id);
  assert.equal(plan.remote.revision, 1);
}
assert.deepEqual((await azure.getWorkItemsReport([1])).missing, []);
assert.equal((await azure.getWorkItems([1])).length, 1);
assert.deepEqual(batchIds([1, 2]), [[1, 2]]);
assert.equal(typeof loadResolutionSdk().readSettings, "function");
assert.equal(typeof loadResolutionSdk([import.meta.url]).readSettings, "function");
assert.equal(typeof loadResolutionSdk([fileURLToPath(import.meta.url)]).readSettings, "function");
assert.throws(() => loadResolutionSdk([]), { code: "configuration" });
assert.equal((await pm.get(item.id)).item.ado_rev, 1);
console.log(JSON.stringify({ ok: true, constructors: services.length, batch_read: "one argument", loader: "default and explicit anchors", sdk_readback: true }));

// Names come from the frozen released index.d.ts, including default and re-exports.
for (const name of ["AdoClient", "AdoResolutionService", "BATCH_LIMIT", "CommandError", "ContractRefusal", "EXIT_CODE", "MOVE_LIMITS", "MUTATING_COMMANDS", "MoveRefusal", "PATCH_MEDIA_TYPE", "RELATION_MAP", "REQUIRED_ENV", "ResolutionRefusal", "RevisionConflict", "STATE_MAP", "assertsRevision", "batchIds", "buildUpdatePatch", "default", "discoverProjectContract", "exportRelations", "importRelations", "mapRelations", "missingEnv", "preflightMessage", "readConfig", "relationTargetId", "resolutionDigest", "resolutionFields", "resolutionScopeReference", "runCredentialPreflight", "shouldFailFast", "simulateMove", "stripTrailingSlashes", "validateResolutionPlan"]) assert.ok(name in publicApi, `missing published export ${name}`);
