import { normalizeItemReference, normalizeScopeValue, type ValueNormalization, type ItemReferenceNormalization } from "./normalization.ts";
/** Revision-bound classification previews using the shared contract and Azure's non-saving validator. */
import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import type { ItemMetadata } from "@unbrained/pm-cli/sdk";
import { AdoClient, buildUpdatePatch, relationTargetId, stripTrailingSlashes, type AdoConfig, type AdoTransport, type AdoWorkItem } from "./index.ts";
import { ContractRefusal, discoverProjectContract } from "./contracts.ts";

/** Hard bounds: one type contract, two batch reads and at most fifty validations. */
export const MOVE_LIMITS = { items: 50, relations: 200, requests: 56 } as const;
/** Stable failures; validation never exposes Azure response messages or credentials. */
export type MoveRefusalCode = "configuration" | "selection" | "budget_exceeded" | "invalid_schema" | "remote_failure" | "permission_denied" | "not_found" | "process_rule" | "revision_changed" | "field_contract";
/** Remedies shared by row-level and whole-preview refusals. */
const remedies: Record<MoveRefusalCode, string> = {
  configuration: "Supply a project name, credentials, one type, explicit item IDs and a project-rooted area or iteration path.",
  selection: "Select 1..50 distinct existing pm IDs with unique positive safe-integer ado_id links in this organization/project; import missing provenance first.",
  budget_exceeded: "Narrow the selection: at most 50 items, 200 direct relations and 56 requests per preview.",
  invalid_schema: "Refresh the Azure snapshot; check complete work item IDs, revisions, project, classification fields and relations.",
  remote_failure: "Check service availability, timeout and the complete local SDK read; retry the preview without applying changes.",
  permission_denied: "Ask an administrator to check effective inherited Edit work items permissions on source and destination areas for this identity.",
  not_found: "Verify visibility of the selected work items and destination classification paths, then refresh the preview.",
  process_rule: "Review the project's custom conditional rules and destination iteration requirements; correct the proposal and validate again.",
  revision_changed: "Re-read the work item and rerun this preview; do not replay the stale revision.",
  field_contract: "Choose the discovered enabled type and writable treePath fields with allowed destination values; refresh the contract.",
};
/** Sanitized actionable SDK exception with the host's semantic exit code. */
export class MoveRefusal extends Error {
  /** Stable refusal code for automated callers. */
  readonly code: MoveRefusalCode;
  /** Next action without remote error text. */
  readonly remedy: string;
  /** Usage errors exit 2; revision conflicts exit 4; other refusals exit 3. */
  readonly exitCode: number;
  /** Bind a stable refusal to its public remedy. */
  constructor(code: MoveRefusalCode) {
    super(`Azure move preview refused: ${code}`);
    this.name = "MoveRefusal"; this.code = code; this.remedy = remedies[code];
    this.exitCode = ["configuration", "selection", "budget_exceeded"].includes(code) ? 2 : code === "revision_changed" ? 4 : 3;
  }
}
/** Explicit selection from a complete SDK snapshot; no inferred bulk selection. */
export interface MoveOptions {
  /** Complete host SDK read, never a bounded list page. */
  items: readonly ItemMetadata[];
  /** Exact pm IDs selected by the caller. */
  ids: readonly string[];
  /** Optional destination area; omitted dimensions retain the observed value. */
  areaPath?: string;
  /** Optional destination iteration. */
  iterationPath?: string;
  /** Single work item type; defaults to Task to keep discovery bounded. */
  type?: string;
  /** Optional pin for the existing field contract fingerprint. */
  expectedFingerprint?: string;
}
/** Classification pair, with no title, description, identity or raw remote URL. */
export interface MoveScope {
  /** Azure area path. */
  area: string;
  /** Azure iteration path. */
  iteration: string;
}
/** One independent rule validation at an observed remote revision. */
export interface MoveRow {
  /** Selected pm identity. */
  id: string;
  /** Linked Azure identity. */
  ado_id: number;
  /** Revision validated, or null when the item is unavailable. */
  rev: number | null;
  /** Allowed means this single validation passed; it is not an apply authorization. */
  decision: "allowed" | "refused";
  /** Stable refusal or null for an allowed row. */
  code: MoveRefusalCode | null;
  /** Specific next step; empty for an allowed row. */
  remedy: string;
  /** Observed scope, null when unavailable. */
  before: MoveScope | null;
  /** Proposed scope, null when unavailable. */
  after: MoveScope | null;
}
/** A preserved direct link's classification boundary before/after all allowed proposals. */
export interface MoveRelation {
  /** Source Azure identity. */
  source: number;
  /** Azure relation reference name. */
  relation: string;
  /** Safe same-organization target identity, null for opaque external/resource links. */
  target: number | null;
  /** Links are never rewritten by classification moves. */
  action: "preserved";
  /** Whether endpoints share each classification, null for an unreadable/opaque target. */
  before: { area: boolean; iteration: boolean } | null;
  /** Scope if every allowed row moves; refused rows retain their observed scope. */
  after: { area: boolean; iteration: boolean } | null;
}
/** Compact deterministic preview with explicit completeness and request accounting. */
export interface MovePreview {
  /** True only when every selected row was allowed. */
  ok: boolean;
  /** Always true; no application capability is exposed. */
  preview: true;
  /** Existing metadata contract pin. */
  fingerprint: string;
  /** Total remote requests including discovery, batch reads and validateOnly calls. */
  requests: number;
  /** Single-item validation results, ordered by pm ID. */
  rows: MoveRow[];
  /** Direct links only; no transitive or team-board membership claim. */
  relations: MoveRelation[];
}
/** Require a documented response shape without disclosing its contents. */
function requireShape(condition: unknown): asserts condition {
  if (!condition) throw new MoveRefusal("invalid_schema");
}
/** Validate only the classification projection needed for direct relation evidence. */
function scope(item: AdoWorkItem): MoveScope {
  requireShape(typeof item.fields === "object" && item.fields !== null);
  const area = item.fields["System.AreaPath"], iteration = item.fields["System.IterationPath"];
  requireShape(typeof area === "string" && area.length > 0 && typeof iteration === "string" && iteration.length > 0);
  return { area, iteration };
}
/** Validate a bounded batch before trusting the existing client's typed response. */
function checked(items: AdoWorkItem[], ids: readonly number[]): Map<number, AdoWorkItem> {
  requireShape(new Set(items.map((item) => item.id)).size === items.length);
  for (const item of items) {
    requireShape(ids.includes(item.id) && Number.isSafeInteger(item.rev) && item.rev > 0);
    scope(item);
    requireShape(item.relations === undefined || Array.isArray(item.relations) && item.relations.every((link) => link !== null && typeof link.rel === "string" && typeof link.url === "string"));
  }
  return new Map(items.map((item) => [item.id, item]));
}
/** Compare classification boundaries without emitting linked item contents. */
function boundary(left: MoveScope, right: MoveScope) {
  return { area: left.area === right.area, iteration: left.iteration === right.iteration };
}
/**
 * Preview only explicit linked items. Azure evaluates inherited permissions and custom rules
 * through revision-checked PATCH validateOnly=true, bypassRules=false. No changes are saved.
 * Single-item validations are observations, not a transaction or a future permission grant.
 */
export async function simulateMove(config: AdoConfig, request: AdoTransport, options: MoveOptions, normalization?: ValueNormalization | ItemReferenceNormalization): Promise<MovePreview> {
  try {
    config = { ...config, orgUrl: normalizeScopeValue(config.orgUrl, true), project: normalizeScopeValue(config.project) };
    const paths = [options.areaPath, options.iterationPath].filter((path) => path !== undefined);
    if (paths.length === 0 || paths.some((path) => typeof path !== "string" || path.length > 1024 || path.split("\\")[0] !== config.project || path.split("\\").some((part) => !part.trim() || [".", ".."].includes(part)))) throw new MoveRefusal("configuration");
    const selectedIds = options.ids.map((id) => normalizeItemReference(id, normalization));
    if (selectedIds.length === 0 || selectedIds.length > MOVE_LIMITS.items || new Set(selectedIds).size !== selectedIds.length) throw new MoveRefusal("selection");
    const selected = selectedIds.map((id) => options.items.find((item) => normalizeItemReference(item.id, normalization) === id));
    if (selected.some((item) => !item || !Number.isSafeInteger(item.ado_id) || Number(item.ado_id) <= 0) || new Set(selected.map((item) => item!.ado_id)).size !== selected.length) throw new MoveRefusal("selection");
    const local = selected as ItemMetadata[];
    /** Compare the same normalized scope for the selected record and potential duplicate identities. */
    const identityScope = (item: ItemMetadata) => ({ org: normalizeScopeValue(String(item.ado_org_url ?? ""), true), project: normalizeScopeValue(String(item.ado_project ?? "")) });
    if (local.some((item) => {
      const current = identityScope(item);
      return current.org !== config.orgUrl || current.project !== config.project || options.items.filter((entry) => {
        if (entry.ado_id !== item.ado_id) return false;
        const candidate = identityScope(entry);
        return candidate.org === current.org && candidate.project === current.project;
      }).length !== 1;
    })) throw new MoveRefusal("selection");
    local.sort((a, b) => a.id < b.id ? -1 : Number(a.id > b.id));
    let requests = 0;
    /** Count every network call and sanitize transport errors before reaching callers. */
    const counted: AdoTransport = async (method, url, body, headers) => {
      if (requests >= MOVE_LIMITS.requests) throw new MoveRefusal("budget_exceeded");
      requests++;
      try { return await request(method, url, body, headers); }
      catch { throw new MoveRefusal("remote_failure"); }
    };
    const type = options.type ?? "Task";
    const contract = await discoverProjectContract(config, counted, { type, expectedFingerprint: options.expectedFingerprint });
    const client = new AdoClient({ ...config, orgUrl: stripTrailingSlashes(config.orgUrl) }, counted);
    const ids = local.map((item) => Number(item.ado_id));
    const remote = checked((await client.getWorkItemsReport(ids)).items, ids);
    const links = [...remote.values()].flatMap((item) => (item.relations ?? []).map((link) => ({ source: item.id, relation: link.rel, target: relationTargetId(link.url, config.orgUrl) ?? null })));
    if (links.length > MOVE_LIMITS.relations) throw new MoveRefusal("budget_exceeded");
    const neighbors = [...new Set(links.flatMap((link) => link.target === null || remote.has(link.target) ? [] : [link.target]))];
    const linked = checked((await client.getWorkItemsReport(neighbors)).items, neighbors);
    const all = new Map([...remote, ...linked]);
    const rows: MoveRow[] = [];
    for (const item of local) {
      const current = remote.get(Number(item.ado_id));
      const before = current ? scope(current) : null;
      const after = before ? { area: options.areaPath ?? before.area, iteration: options.iterationPath ?? before.iteration } : null;
      let code: MoveRefusalCode | null = null;
      if (!current) code = "not_found";
      else if (current.fields["System.TeamProject"] !== config.project || current.fields["System.WorkItemType"] !== type || contract.types[0]!.disabled) code = "field_contract";
      else {
        const fields = Object.fromEntries([["System.AreaPath", options.areaPath], ["System.IterationPath", options.iterationPath]].filter(([, value]) => value !== undefined));
        if (Object.entries(fields).some(([ref, value]) => {
          const field = contract.types[0]!.fields.find((entry) => entry.ref === ref);
          return !field || !field.writable || field.type !== "treePath" || field.allowed.length > 0 && !field.allowed.includes(value);
        })) code = "field_contract";
        else {
          const url = `${stripTrailingSlashes(config.orgUrl)}/${encodeURIComponent(config.project)}/_apis/wit/workitems/${current.id}?api-version=7.1&validateOnly=true&bypassRules=false`;
          const response = await counted("PATCH", url, JSON.stringify(buildUpdatePatch(current.rev, fields)), { Accept: "application/json", "Content-Type": "application/json-patch+json", Authorization: `Basic ${Buffer.from(`:${config.token}`).toString("base64")}` });
          if (response.status !== 200) code = ({ 400: "process_rule", 401: "permission_denied", 403: "permission_denied", 404: "not_found", 409: "revision_changed", 412: "revision_changed" } as Record<number, MoveRefusalCode>)[response.status] ?? "remote_failure";
          else {
            let validated: AdoWorkItem;
            try { validated = JSON.parse(response.body) as AdoWorkItem; } catch { throw new MoveRefusal("invalid_schema"); }
            requireShape(validated !== null && validated.id === current.id);
            const observed = scope(validated);
            requireShape(observed.area === after!.area && observed.iteration === after!.iteration);
          }
        }
      }
      rows.push({ id: item.id, ado_id: Number(item.ado_id), rev: current?.rev ?? null, decision: code ? "refused" : "allowed", code, remedy: code ? remedies[code] : "", before, after });
    }
    /** Only allowed proposals participate in the downstream scope scenario. */
    const proposed = (id: number): MoveScope => {
      const row = rows.find((entry) => entry.ado_id === id && entry.decision === "allowed");
      return row ? row.after! : scope(all.get(id)!);
    };
    const relations: MoveRelation[] = links.map((link) => ({ ...link, action: "preserved", before: link.target !== null && all.has(link.target) ? boundary(scope(all.get(link.source)!), scope(all.get(link.target)!)) : null,
      after: link.target !== null && all.has(link.target) ? boundary(proposed(link.source), proposed(link.target)) : null }));
    relations.sort((a, b) => { const left = JSON.stringify(a), right = JSON.stringify(b); return left < right ? -1 : Number(left > right); });
    return { ok: rows.every((row) => row.decision === "allowed"), preview: true, fingerprint: contract.fingerprint, requests, rows, relations };
  } catch (error) {
    if (error instanceof MoveRefusal || error instanceof ContractRefusal) throw error;
    throw new MoveRefusal("remote_failure");
  }
}
/** Timeout-bound transport that cannot redirect validation into a saving endpoint. */
async function moveTransport(method: string, url: string, body: string | undefined, headers: Readonly<Record<string, string>>) {
  const response = await fetch(url, { method, body, headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
  return { status: response.status, body: await response.text() };
}
/** Read the complete host snapshot and delegate rendering to the pm command runtime. */
export async function runMoveCommand(ctx: CommandHandlerContext) {
  try {
    /** Accept the host's normalized camelCase and direct kebab-case SDK options. */
    const option = (name: string): string | undefined => {
      const value = ctx.options[name] ?? ctx.options[name.replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase())];
      if (value !== undefined && (typeof value !== "string" || !value.trim())) throw new MoveRefusal("configuration");
      return value;
    };
    const project = option("project"), items = option("items");
    if (!project || !items || !ctx.sdk?.client || !process.env.ADO_ORG_URL?.trim() || !process.env.ADO_TOKEN?.trim()) throw new MoveRefusal("configuration");
    const references = items.split(","), client = ctx.sdk.client;
    if (references.length > MOVE_LIMITS.items) throw new MoveRefusal("selection");
    const snapshot = (await client.listAllComplete()).items;
    const canonical = new Map(snapshot.map((item) => [item.id, item.id]));
    for (const reference of references) {
      try { const id = (await client.get(reference)).item.id; canonical.set(reference, id); canonical.set(id, id); }
      catch (error) { if (ctx.sdk.isItemNotFoundError(error)) throw new MoveRefusal("selection"); throw error; }
    }
    // simulateMove resolves only these certified references and snapshot IDs.
    const normalization = { resolveReference: (value: string) => canonical.get(value)! };
    return await simulateMove({ orgUrl: process.env.ADO_ORG_URL.trim(), project, token: process.env.ADO_TOKEN.trim() }, moveTransport,
      { items: snapshot, ids: references, areaPath: option("area-path"), iterationPath: option("iteration-path"), type: option("type"), expectedFingerprint: option("expect-fingerprint") }, normalization);
  } catch (error) {
    const refusal = error instanceof MoveRefusal || error instanceof ContractRefusal ? error : new MoveRefusal("remote_failure");
    process.exitCode = refusal.exitCode;
    return { ok: false, preview: true, code: refusal.code, remedy: refusal.remedy, exit_code: refusal.exitCode };
  }
}
