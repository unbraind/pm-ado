/** Portable, revision-bound decisions over the existing Azure sync field map. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type * as Sdk from "@unbrained/pm-cli/sdk";
import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import { AdoClient, CommandError, RevisionConflict, STATE_MAP, readConfig, type AdoConfig, type AdoWorkItem } from "./index.ts";
import { ADO_FIELD_MAP, IMPORT_STATE_MAP, azureFields, localValues, readBase, remoteValues, stateMap, transport, threeWayFieldConflict } from "./sync.ts";

/** Stable refusals agents can branch on without parsing error prose. */
export type ResolutionRefusalCode = "invalid_plan" | "invalid_choices" | "stale_local" | "stale_remote" | "scope" | "configuration" | "apply_failed";
/** A failed decision with a concrete recovery action; server bodies are never exposed. */
export class ResolutionRefusal extends Error {
  /** Semantic conflict exit propagated by the host runtime. */
  readonly exitCode = 4;
  /** Stable reason for refusing the decision. */
  readonly code: ResolutionRefusalCode;
  /** Concrete recovery action for the agent. */
  readonly remedy: string;
  /** Preserve the machine-readable reason and caller remedy. */
  constructor(code: ResolutionRefusalCode, remedy: string) {
    super(`Azure resolution refused: ${code}`);
    this.name = "ResolutionRefusal";
    this.code = code;
    this.remedy = remedy;
  }

  /** Preserve semantic refusals and map REST races without exposing service bodies. */
  static from(error: unknown): ResolutionRefusal {
    if (error instanceof ResolutionRefusal) return error;
    if (error instanceof CommandError && error.exitCode === 2) return new ResolutionRefusal("configuration", "Check configured state maps and field values before generating a new plan.");
    if (error instanceof RevisionConflict) return new ResolutionRefusal("stale_remote", "Azure changed during PATCH. Generate a fresh plan; the revision assertion applied no fields.");
    return new ResolutionRefusal("apply_failed", "Inspect tracker health and Azure connectivity. Re-read both sides before retrying; an external write may have succeeded before a local failure.");
  }
}
/** A field decision chooses an observed value, never an unchecked replacement. */
export interface ResolutionChoice {
  /** Canonical pm field from the existing sync map. */
  field: string;
  /** Snapshot whose value wins on both sides. */
  take: "local" | "remote";
}
/** Compact field coordinates avoid copying titles, descriptions or identities into plans. */
export interface ResolutionField {
  /** Canonical field name. */
  field: string;
  /** Digest of the last shared value, or null for a legacy missing base. */
  base: string | null;
  /** Digest of the observed pm value. */
  local: string;
  /** Digest of the observed Azure value. */
  remote: string;
  /** Both writers changed this field since the base. */
  conflict: boolean;
}
/** Portable artifact; a core Plan item may store this JSON in its body. */
export interface ResolutionPlan {
  /** Versioned package decision contract, independent of core Plan storage. */
  schema: "pm-ado/resolution/1";
  /** Azure scope; never includes the access token. */
  scope: { org: string; project: string };
  /** Exact local identity and canonical whole-document revision digest. */
  local: { id: string; revision: string };
  /** Azure identity, revision and full REST snapshot digest. */
  remote: { id: number; revision: number; digest: string };
  /** Digests for every mapped scalar field; no implicit field winner. */
  fields: ResolutionField[];
  /** Normalized state-map digest prevents configuration changes reinterpreting decisions. */
  mapping: string;
  /** Exactly one choice per differing field; initially empty for agent review. */
  choices: ResolutionChoice[];
}
/** Successful application receipt, intentionally independent of private field values. */
export interface ResolutionReceipt {
  /** Successful commit or an already committed decision. */
  ok: true;
  /** Stable idempotency coordinate including the selected choices. */
  decision: string;
  /** True when the saved receipt already proves application. */
  replayed: boolean;
  /** Local item whose immutable history holds the decision. */
  pm_id: string;
}

/** Hash recursively sorted JSON so artifact property order has no semantics. */
export function resolutionDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry)).digest("hex");
}

/** Resolve the public SDK from this package or the running host, including copied extensions. */
export function loadResolutionSdk(anchors: readonly string[] = [import.meta.url, resolve(process.argv[1] ?? "pm")]): typeof Sdk {
  for (const anchor of anchors) {
    try { return createRequire(anchor)("@unbrained/pm-cli/sdk") as typeof Sdk; } catch { /* Try the host's package resolution anchor. */ }
  }
  throw new ResolutionRefusal("configuration", "Run with pm CLI 2026.10.23 or newer, which fences expired item mutation leases.");
}

/** Refuse malformed portable input before opening a mutation or contacting Azure. */
export function validateResolutionPlan(input: unknown): asserts input is ResolutionPlan {
  if (typeof input !== "object" || input === null) throw new ResolutionRefusal("invalid_plan", "Generate a new plan with ado resolve-plan.");
  const p = input as Partial<ResolutionPlan>;
  const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
  if (p.schema !== "pm-ado/resolution/1" || typeof p.scope?.org !== "string" || typeof p.scope.project !== "string" ||
      typeof p.local?.id !== "string" || !hash(p.local.revision) || !Number.isSafeInteger(p.remote?.id) || Number(p.remote?.id) < 1 ||
      !Number.isSafeInteger(p.remote?.revision) || Number(p.remote?.revision) < 1 || !hash(p.remote?.digest) || !hash(p.mapping) ||
      !Array.isArray(p.fields) || p.fields.length !== Object.keys(ADO_FIELD_MAP).length ||
      p.fields.some((f) => typeof f !== "object" || f === null || !Object.hasOwn(ADO_FIELD_MAP, f.field) || !hash(f.local) || !hash(f.remote) ||
        !(f.base === null || hash(f.base)) || typeof f.conflict !== "boolean") || new Set(p.fields.map((f) => f.field)).size !== p.fields.length) {
    throw new ResolutionRefusal("invalid_plan", "Generate a complete version 1 plan; do not edit its snapshot coordinates.");
  }
  const required = p.fields.filter((f) => f.local !== f.remote).map((f) => f.field);
  if (!Array.isArray(p.choices) || p.choices.length !== required.length || new Set(p.choices.map((c) => c?.field)).size !== p.choices.length ||
      p.choices.some((c) => typeof c !== "object" || c === null || !required.includes(c.field) || !["local", "remote"].includes(c.take))) {
    throw new ResolutionRefusal("invalid_choices", "Choose local or remote exactly once for every differing field; remove unknown, duplicate and redundant choices.");
  }
}

/** Configured state interpretation bound into every portable plan. */
export interface ResolutionMaps {
  /** Azure-to-pm lifecycle states. */
  imports: Readonly<Record<string, string>>;
  /** pm-to-Azure lifecycle states. */
  exports: Readonly<Record<string, string>>;
}

/** Build digests from the same field projections and three-way base used by sync. */
export function resolutionFields(item: Sdk.ItemMetadata, remote: AdoWorkItem, maps: ResolutionMaps): ResolutionField[] {
  const local = localValues(item);
  const incoming = remoteValues(remote, maps.imports);
  const base = readBase(item, { ...incoming, relations: [] });
  if (base !== undefined && maps.exports[String(base.status)] === remote.fields["System.State"]) incoming.status = base.status;
  return Object.keys(ADO_FIELD_MAP).map((field) => ({ field, base: base === undefined ? null : resolutionDigest(base[field]),
    local: resolutionDigest(local[field]), remote: resolutionDigest(incoming[field]),
    conflict: threeWayFieldConflict(local[field], incoming[field], base?.[field]) }));
}


/** Revision-bound decisions use core reads, Plan storage and audited item mutation, never git. */
export class AdoResolutionService {
  private readonly pmRoot: string;
  private readonly author: string;
  private readonly pm: Sdk.PmClient;
  private readonly client: AdoClient;
  private readonly config: AdoConfig;
  private readonly sdk: typeof Sdk;
  /** Bind one public SDK workspace and Azure REST client to an attributable caller. */
  constructor(pmRoot: string, author: string, pm: Sdk.PmClient,
    client: AdoClient, config: AdoConfig, sdk = loadResolutionSdk()) {
    this.pmRoot = pmRoot; this.author = author; this.pm = pm;
    this.client = client; this.config = config; this.sdk = sdk;
  }

  /** Load authoritative item bytes with the same SDK normalization used by the mutation lock. */
  private async document(id: string) {
    const settings = await this.sdk.readSettings(this.pmRoot);
    const located = await this.sdk.locateItem(this.pmRoot, id, settings.id_prefix);
    if (located === null) throw new ResolutionRefusal("scope", "Select an existing linked pm item and generate a fresh plan.");
    const { document } = await this.sdk.readLocatedItem(located, { schema: settings.schema });
    return document;
  }

  /** Check identity and scope on every read, including when applying a portable artifact. */
  private scope(item: Sdk.ItemMetadata, remote: AdoWorkItem): void {
    if (item.ado_org_url !== this.config.orgUrl || item.ado_project !== this.config.project || item.ado_id !== remote.id ||
        !Number.isSafeInteger(remote.rev) || remote.rev < 1) {
      throw new ResolutionRefusal("scope", "Use the original organization, project and linked identities; import first if provenance is missing.");
    }
  }

  /** Require one hydrated REST work item rather than accepting an omitted batch row. */
  private async remote(id: number): Promise<AdoWorkItem> {
    const rows = await this.client.getWorkItems([id]);
    const remote = rows[0];
    if (rows.length !== 1 || remote.id !== id || typeof remote.fields !== "object" || remote.fields === null || Array.isArray(remote.fields)) {
      throw new ResolutionRefusal("stale_remote", "Azure omitted or changed the linked work item. Re-read its identity before planning.");
    }
    return remote;
  }

  /** Read normalized configured maps once per operation and bind their interpretation to the plan. */
  private maps() {
    return { imports: stateMap(process.env.ADO_STATUS_MAP, IMPORT_STATE_MAP), exports: stateMap(process.env.ADO_EXPORT_STATE_MAP, STATE_MAP) };
  }

  /** Preview one linked item's scalar decisions with no tracker or REST writes. */
  async plan(id: string): Promise<ResolutionPlan> {
    try {
      const { items } = await this.pm.listAllComplete();
      const document = await this.document(id);
      const item = document.metadata;
      if (items.filter((row) => row.ado_id === item.ado_id).length !== 1 || !Number.isSafeInteger(item.ado_id) || Number(item.ado_id) < 1) {
        throw new ResolutionRefusal("scope", "Import and establish one unique local link for this Azure work item before planning.");
      }
      const remote = await this.remote(Number(item.ado_id));
      this.scope(item, remote);
      const maps = this.maps();
      return { schema: "pm-ado/resolution/1", scope: { org: this.config.orgUrl, project: this.config.project },
        local: { id: item.id, revision: resolutionDigest(document) },
        remote: { id: remote.id, revision: remote.rev, digest: resolutionDigest(remote) },
        fields: resolutionFields(item, remote, maps), mapping: resolutionDigest(maps), choices: [] };
    } catch (error) { throw ResolutionRefusal.from(error); }
  }

  /** Apply under the core item lease; validate all choices and both revisions before a REST write. */
  async apply(input: unknown): Promise<ResolutionReceipt> {
    try {
      validateResolutionPlan(input);
      const plan = structuredClone(input);
      plan.fields.sort((a, b) => a.field.localeCompare(b.field));
      plan.choices.sort((a, b) => a.field.localeCompare(b.field));
      const decision = resolutionDigest(plan);
      const maps = this.maps();
      if (plan.scope.org !== this.config.orgUrl || plan.scope.project !== this.config.project || plan.mapping !== resolutionDigest(maps)) {
        throw new ResolutionRefusal("scope", "Restore the original Azure scope and state maps, or generate a fresh plan.");
      }
      let replayed = false;
      const settings = await this.sdk.readSettings(this.pmRoot);
      await this.sdk.mutateItemWithHistoryContext({ pmRoot: this.pmRoot, settings,
        id: plan.local.id, author: this.author, op: "update", skipNoop: true,
        message: `Azure resolution ${decision}`, historyContext: { ado_resolution: decision },
        mutate: async (document) => {
          const item = document.metadata;
          if (item.ado_resolution_receipt === decision ||
              (await this.sdk.readHistorySnapshot(this.sdk.getHistoryPath(this.pmRoot, item.id), item.id)).entries.some((entry) => entry.context?.ado_resolution === decision)) { replayed = true; return { changedFields: [] }; }
          if (resolutionDigest(document) !== plan.local.revision) throw new ResolutionRefusal("stale_local", "A local writer changed the item. Generate a new plan and review its choices.");
          const remote = await this.remote(plan.remote.id);
          this.scope(item, remote);
          if (remote.rev !== plan.remote.revision || resolutionDigest(remote) !== plan.remote.digest) {
            throw new ResolutionRefusal("stale_remote", "An Azure writer changed the item. Generate a new plan and review its choices.");
          }
          if (resolutionDigest(resolutionFields(item, remote, maps).sort((a, b) => a.field.localeCompare(b.field))) !== resolutionDigest(plan.fields)) {
            throw new ResolutionRefusal("invalid_plan", "Snapshot field digests were edited; generate a fresh plan.");
          }
          const local = localValues(item);
          const values = remoteValues(remote, maps.imports);
          // A shared Azure state can represent multiple pm states; use sync's agreed base interpretation.
          const base = readBase(item, { ...values, relations: [] });
          if (base !== undefined && maps.exports[String(base.status)] === remote.fields["System.State"]) values.status = base.status;
          for (const choice of plan.choices) if (choice.take === "local") values[choice.field] = local[choice.field];
          const exports = Object.keys(ADO_FIELD_MAP).filter((field) => resolutionDigest(values[field]) !== plan.fields.find((f) => f.field === field)!.remote);
          const fields = azureFields(values, exports, maps.exports);
          // Validate the local lifecycle/schema before the external side effect using core's staged mutation preview.
          await this.sdk.previewItemMutations({ pmRoot: this.pmRoot, transactionId: `ado-${decision}`, author: this.author,
            mutations: [{ op: "update", id: item.id, options: { title: String(values.title), description: String(values.description),
              status: String(values.status), priority: Number(values.priority), tags: JSON.stringify(values.tags),
              ...(values.assignee === "" ? { unset: ["assignee"] } : { assignee: String(values.assignee) }),
              closeReason: "Azure conflict resolution" } }] });
          const previousStatus = item.status;
          const result = exports.length ? await this.client.updateWorkItem(remote.id, remote.rev, fields) : remote;
          for (const key of Object.keys(ADO_FIELD_MAP)) item[key] = values[key];
          if (values.assignee === "") delete item.assignee;
          const statuses = this.sdk.resolveRuntimeStatusRegistry(settings.schema);
          const lifecycleFields: string[] = [];
          if (item.status !== previousStatus) {
            if (item.status === statuses.close_status) {
              item.closed_at = this.sdk.nowIso(); item.completed_at = item.closed_at;
              item.close_reason = "Azure conflict resolution";
              lifecycleFields.push("closed_at", "completed_at", "close_reason");
            } else if (!this.sdk.isTerminalStatus(item.status, statuses) && this.sdk.isTerminalStatus(previousStatus, statuses)) {
              for (const key of ["closed_at", "completed_at", "close_reason", "resolution", "expected_result", "actual_result", "fixed_version"]) {
                delete item[key]; lifecycleFields.push(key);
              }
            }
          }
          item.ado_rev = result.rev;
          // Scalar decisions leave graph reconciliation to the existing relation adapter.
          if (base !== undefined) item.ado_sync_base = JSON.stringify({ ...base, ...values });
          item.ado_resolution_receipt = decision;
          return { changedFields: [...lifecycleFields, ...Object.keys(ADO_FIELD_MAP), "ado_rev", "ado_sync_base", "ado_resolution_receipt"] };
        } });
      return { ok: true, decision, replayed, pm_id: plan.local.id };
    } catch (error) { throw ResolutionRefusal.from(error); }
  }
}

/** CLI bridge with host-owned compact TOON/JSON rendering and core Plan persistence. */
export async function runResolutionCommand(ctx: CommandHandlerContext, mode: "plan" | "apply") {
  try {
    const config = readConfig(process.env);
    if (config === undefined || ctx.sdk === undefined) throw new ResolutionRefusal("configuration", "Set ADO_ORG_URL, ADO_PROJECT and ADO_TOKEN; run with pm CLI 2026.10.23 or newer.");
    const service = new AdoResolutionService(ctx.pm_root, ctx.global.author ?? process.env.PM_AUTHOR ?? "unknown", ctx.sdk.client, new AdoClient(config, transport), config);
    if (mode === "plan") {
      if (typeof ctx.options.item !== "string") throw new ResolutionRefusal("configuration", "Supply --item with one linked pm item ID.");
      const plan = await service.plan(ctx.options.item);
      if (ctx.options.save === true) {
        const saved = await ctx.sdk.client.planCreate({ title: "Azure field conflict decisions", body: JSON.stringify(plan) });
        return { ok: true, plan_id: saved.plan.id, plan };
      }
      return { ok: true, plan };
    }
    if ((typeof ctx.options.plan === "string") === (typeof ctx.options.artifact === "string")) {
      throw new ResolutionRefusal("configuration", "Supply exactly one of --plan (core Plan ID) or --artifact (portable JSON file).");
    }
    const raw = typeof ctx.options.plan === "string" ? (await ctx.sdk.client.get(ctx.options.plan, { depth: "full" })).item.body
      : await readFile(String(ctx.options.artifact), "utf8");
    let plan: unknown;
    try { plan = JSON.parse(String(raw)); } catch { throw new ResolutionRefusal("invalid_plan", "Use a core Plan body or JSON artifact produced by ado resolve-plan."); }
    return await service.apply(plan);
  } catch (error) {
    const refusal = ResolutionRefusal.from(error);
    return { ok: false, code: refusal.code, remedy: refusal.remedy, exit_code: refusal.exitCode };
  }
}
