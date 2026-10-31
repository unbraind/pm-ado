import { baseFields, fieldAtRevision, readBaseRevisions } from "./agreement.ts";
import { normalizeScopeValue } from "./normalization.ts";
/** Read-only Azure refresh compiler; artifacts describe reads and never authorize writes. */
import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import type { ItemMetadata, PmClient } from "@unbrained/pm-cli/sdk";
import { AdoClient, batchIds, readConfig, type AdoConfig, type AdoTransport } from "./index.ts";
import { ADO_FIELD_MAP, localValues, readBase, transport } from "./sync.ts";

/** Native pm fields whose Azure projection this package owns. */
export type RefreshField = "title" | "description" | "status" | "priority" | "tags" | "assignee" | "ado_area_path" | "ado_iteration_path" | "relations";
/** Compact revision/base evidence, without item contents. */
export interface RefreshSaved {
  /** Azure positive int32 identity. */
  id: number;
  /** Saved Azure revision, null for legacy links. */
  revision: number | null;
  /** Fields present in the saved base; a base is reusable only at its exact revision. */
  base: RefreshField[];
  /** Optional per-field witnessed revisions; missing entries are never cached. */
  revisions?: Record<string, number>;
}
/** Revision-only observation, obtained anew on every invocation. */
export interface RefreshRevision {
  /** Azure identity returned by the probe. */
  id: number;
  /** Current Azure positive int32 revision. */
  revision: number;
}
/** Strict portable compiler input; omitted observations compile just the probe phase. */
export interface RefreshInput {
  /** Declared native field needs, unique and nonempty. */
  needs: RefreshField[];
  /** Unique linked items, up to 10000. */
  saved: RefreshSaved[];
  /** Complete probe result; omitted IDs are unavailable, never deleted. */
  observed?: RefreshRevision[];
  /** Complete JSON receipt budget, 1024..1048576 bytes, default 65536. */
  maxOutputBytes?: number;
}
/** A directly usable Azure 7.1 batch request body. */
export interface RefreshBatch {
  /** At most 200 identities. */
  ids: number[];
  /** Smallest shared projection for this batch, including the revision guard. */
  fields: string[];
  /** Omission is an unavailable row, not a deletion. */
  errorPolicy: "omit";
  /** Relations are expanded only when declared and uncached. */
  $expand?: "relations";
}
/** Reviewable read costs and total per-field accounting; no mutation instructions. */
export interface RefreshPlan {
  /** Successful compilation, including explicitly unavailable rows. */
  ok: true;
  /** Stable portable artifact version. */
  schema: "pm-ado/refresh/1";
  /** Probe artifacts must be completed with fresh observations. */
  phase: "probe" | "refresh";
  /** Revision-only requests. */
  probe: RefreshBatch[];
  /** Follow-up requests for changed or uncached fields. */
  hydrate: RefreshBatch[];
  /** Exact-revision matches, independent of cache completeness. */
  unchanged: number[];
  /** Returned revisions differing from the saved revision. */
  changed: number[];
  /** Omitted probe identities; retry access, never delete. */
  unavailable: number[];
  /** Every declared need is cached, scheduled for reading, or unavailable. */
  accounting: { field: RefreshField; cached: number; read: number; unavailable: number; pending: number }[];
  /** Foreign and unrelated records are skipped without claiming ownership. */
  skipped?: { reason: "unlinked" | "foreign_scope"; count: number }[];
  /** Bounded integer costs; mutations are always zero. */
  cost: { items: number; probe_reads: number; hydrate_reads: number; field_cells: number; pm_mutations: 0 };
}
/** Machine-readable refusal categories; messages never include tracker contents. */
export type RefreshRefusalCode = "invalid_input" | "scope" | "configuration" | "remote_failure" | "output_budget";
/** Typed, remedy-bearing failure shared by SDK and CLI callers. */
export class RefreshRefusal extends Error {
  /** Stable machine-readable category. */
  readonly code: RefreshRefusalCode;
  /** Concrete next action for the caller. */
  readonly remedy: string;
  /** Host command exit status. */
  readonly exitCode = 2;
  /** Construct a sanitized refusal without remote error bodies. */
  constructor(code: RefreshRefusalCode) {
    const remedies = {
      invalid_input: "Use unique int32 IDs/revisions, dense bounded arrays, known fields and a 1024..1048576 byte budget; regenerate malformed base evidence.",
      scope: "Select links from this Azure organization and project only; repair duplicate identities before planning.",
      configuration: "Run inside an initialized pm tracker with ADO_ORG_URL, ADO_PROJECT and ADO_TOKEN; supply --fields as comma-separated native field names.",
      remote_failure: "Check tracker validity, read permissions and connectivity, then rerun the revision probe; never apply a saved refresh artifact as a write plan.",
      output_budget: "Select fewer linked items or raise --max-output-bytes up to 1048576; no receipt was truncated.",
    };
    super(remedies[code]); this.name = "RefreshRefusal"; this.code = code; this.remedy = remedies[code];
  }
}

/** Require one strict schema predicate at an external boundary. */
function requireInput(value: unknown): asserts value { if (!value) throw new RefreshRefusal("invalid_input"); }
/** Accept plain records only, with exactly the documented keys. */
function record(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  requireInput(typeof value === "object" && value !== null && !Array.isArray(value));
  requireInput(required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => [...required, ...optional].includes(key)));
}
/** Dense arrays prevent holes from escaping Array.every and serializing as null. */
function dense(value: unknown, max: number): asserts value is unknown[] {
  requireInput(Array.isArray(value) && value.length <= max && Object.keys(value).length === value.length);
  for (let index = 0; index < value.length; index++) requireInput(Object.hasOwn(value, index));
}
/** Azure IDs and revisions are int32; every emitted count uses this domain too. */
function int32(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2147483647; }
/** Single strict request schema, reused when remote observations enter the compiler. */
export function validateRefreshInput(value: unknown): asserts value is RefreshInput {
  record(value, ["needs", "saved"], ["observed", "maxOutputBytes"]);
  const fields = [...Object.keys(ADO_FIELD_MAP), "relations"];
  /** Validate an exact subset without normalizing caller data. */
  const subset = (input: unknown) => { dense(input, fields.length); requireInput(new Set(input).size === input.length && input.every((field) => typeof field === "string" && fields.includes(field))); };
  subset(value.needs); requireInput((value.needs as unknown[]).length > 0);
  dense(value.saved, 10000);
  for (const row of value.saved) {
    record(row, ["id", "revision", "base"], ["revisions"]); requireInput(int32(row.id) && (row.revision === null || int32(row.revision))); subset(row.base);
    if (row.revisions !== undefined) {
      record(row.revisions, [], fields);
      requireInput(Object.values(row.revisions).every(int32));
    }
  }
  requireInput(new Set(value.saved.map((row) => (row as RefreshSaved).id)).size === value.saved.length);
  if (value.observed !== undefined) {
    dense(value.observed, value.saved.length);
    const ids = new Set(value.saved.map((row) => (row as RefreshSaved).id));
    for (const row of value.observed) { record(row, ["id", "revision"]); requireInput(int32(row.id) && ids.has(row.id) && int32(row.revision)); }
    requireInput(new Set(value.observed.map((row) => (row as RefreshRevision).id)).size === value.observed.length);
  }
  if (value.maxOutputBytes !== undefined) requireInput(typeof value.maxOutputBytes === "number" && Number.isInteger(value.maxOutputBytes) && value.maxOutputBytes >= 1024 && value.maxOutputBytes <= 1048576);
}
/** Compile fresh revision evidence into deterministic minimum-round-trip batch reads. Never applies or persists a plan. */
export function compileRefreshPlan(input: RefreshInput): RefreshPlan {
  validateRefreshInput(input);
  const needs = [...input.needs].sort();
  const saved = [...input.saved].sort((a, b) => a.id - b.id);
  const observed = new Map(input.observed?.map((row) => [row.id, row.revision]));
  const unchanged: number[] = [], changed: number[] = [], unavailable: number[] = [];
  const accounting = needs.map((field) => ({ field, cached: 0, read: 0, unavailable: 0, pending: input.observed === undefined ? saved.length : 0 }));
  const pending = new Map<number, RefreshField[]>();
  if (input.observed !== undefined) for (const row of saved) {
    const revision = observed.get(row.id);
    if (revision === undefined) { unavailable.push(row.id); for (const count of accounting) count.unavailable++; continue; }
    const same = row.revision === revision;
    (same ? unchanged : changed).push(row.id);
    const missing: RefreshField[] = [];
    for (const count of accounting) {
      if (fieldAtRevision(count.field, row.base, row.revision, revision, row.revisions)) count.cached++;
      else { count.read++; missing.push(count.field); }
    }
    if (missing.length) pending.set(row.id, missing);
  }
  const probe: RefreshBatch[] = batchIds(saved.map((row) => row.id)).map((ids) => ({ ids, fields: ["System.Rev"], errorPolicy: "omit" }));
  const hydrate: RefreshBatch[] = batchIds([...pending.keys()]).map((ids) => {
    const fields = new Set(ids.flatMap((id) => pending.get(id)!));
    return { ids, fields: ["System.Rev", ...[...fields].filter((field) => field !== "relations").map((field) => ADO_FIELD_MAP[field]).sort()],
      errorPolicy: "omit", ...(fields.has("relations") ? { $expand: "relations" as const } : {}) };
  });
  const plan: RefreshPlan = { ok: true, schema: "pm-ado/refresh/1", phase: input.observed === undefined ? "probe" : "refresh", probe, hydrate, unchanged, changed, unavailable,
    accounting, cost: { items: saved.length, probe_reads: probe.length, hydrate_reads: hydrate.length,
      field_cells: hydrate.reduce((sum, batch) => sum + batch.ids.length * (batch.fields.length - 1 + Number(batch.$expand === "relations")), 0), pm_mutations: 0 } };
  // All output numbers must remain bounded and finite, including derived costs.
  const numbers = [plan.cost.items, plan.cost.probe_reads, plan.cost.hydrate_reads, plan.cost.field_cells, plan.cost.pm_mutations,
    ...accounting.flatMap((row) => [row.cached, row.read, row.unavailable, row.pending])];
  requireInput(numbers.every((value) => Number.isInteger(value) && value >= 0 && value <= 100000));
  if (Buffer.byteLength(JSON.stringify(plan)) > (input.maxOutputBytes ?? 65536)) throw new RefreshRefusal("output_budget");
  return plan;
}
/** Project only owned Azure evidence from an SDK-certified tracker snapshot, skipping unrelated/foreign records. */
export function refreshSaved(items: readonly ItemMetadata[], config: AdoConfig): RefreshSaved[] {
  const saved: RefreshSaved[] = [];
  for (const item of items) {
    if (item.ado_id === undefined || normalizeScopeValue(String(item.ado_org_url ?? ""), true) !== normalizeScopeValue(config.orgUrl, true) || normalizeScopeValue(String(item.ado_project ?? "")) !== normalizeScopeValue(config.project)) continue;
    let base;
    // Sparse coverage coordinates need shape only; no semantic value comparison or native write occurs here.
    try { base = readBase(item, localValues(item, false), false); } catch { throw new RefreshRefusal("invalid_input"); }
    let revisions: Record<string, number> | undefined;
    if (base?.ado_agreed_revisions !== undefined) {
      try { revisions = Object.fromEntries(Object.entries(readBaseRevisions(base)).filter(([field]) => baseFields(base).includes(field))); }
      catch { revisions = {}; /* Unreadable historical witnesses provide no cache evidence. */ }
    }
    saved.push({ id: Number(item.ado_id), revision: item.ado_rev === undefined ? null : Number(item.ado_rev),
      base: baseFields(base).filter((field) => [...Object.keys(ADO_FIELD_MAP), "relations"].includes(field)) as RefreshField[],
      ...(revisions === undefined ? {} : { revisions }) });
  }
  return saved;
}
/** Probe through the existing Azure batch client, compile remaining reads, and leave both trackers unchanged. */
export async function observeRefreshPlan(pm: Pick<PmClient, "listAllComplete">, config: AdoConfig, request: AdoTransport,
  needs: RefreshField[], maxOutputBytes?: number): Promise<RefreshPlan> {
  try {
    const items = (await pm.listAllComplete()).items;
    const saved = refreshSaved(items, config);
    const input = { saved, needs, maxOutputBytes };
    const initial = compileRefreshPlan(input); // Refuse invalid selection and receipt budget before any request.
    const result = await new AdoClient(config, request).getWorkItemsReport(initial.probe.flatMap((batch) => batch.ids), { fields: ["System.Rev"] });
    const currentItems = (await pm.listAllComplete()).items;
    const currentSaved = refreshSaved(currentItems, config);
    if (JSON.stringify(currentSaved.map((row) => row.id).sort((a, b) => a - b)) !== JSON.stringify(saved.map((row) => row.id).sort((a, b) => a - b))) throw new RefreshRefusal("scope");
    const plan = compileRefreshPlan({ ...input, saved: currentSaved, observed: result.items.map((item) => ({ id: item.id, revision: item.rev })) });
    plan.skipped = [
      { reason: "unlinked", count: currentItems.filter((item) => item.ado_id === undefined).length },
      { reason: "foreign_scope", count: currentItems.filter((item) => item.ado_id !== undefined && (normalizeScopeValue(String(item.ado_org_url ?? ""), true) !== normalizeScopeValue(config.orgUrl, true) || normalizeScopeValue(String(item.ado_project ?? "")) !== normalizeScopeValue(config.project))).length },
    ];
    if (Buffer.byteLength(JSON.stringify(plan)) > (maxOutputBytes ?? 65536)) throw new RefreshRefusal("output_budget");
    return plan;
  } catch (error) {
    if (error instanceof RefreshRefusal) throw error;
    throw new RefreshRefusal("remote_failure");
  }
}
/** Delegate complete reads and TOON/JSON rendering to the host SDK, without git or mutation APIs. */
export async function runRefreshCommand(ctx: CommandHandlerContext) {
  try {
    const config = readConfig(process.env), fields = ctx.options.fields;
    if (!config || !ctx.sdk?.client || typeof fields !== "string") throw new RefreshRefusal("configuration");
    const maxOutputBytes = ctx.options.maxOutputBytes ?? ctx.options["max-output-bytes"];
    return await observeRefreshPlan(ctx.sdk.client, config, transport, fields.split(",") as RefreshField[], maxOutputBytes as number | undefined);
  } catch (error) {
    const refusal = error instanceof RefreshRefusal ? error : new RefreshRefusal("remote_failure");
    process.exitCode = refusal.exitCode;
    return { ok: false, code: refusal.code, remedy: refusal.remedy, exit_code: refusal.exitCode };
  }
}
