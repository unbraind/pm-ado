/** Shared field representations for SDK writes and semantic comparison; raw guards stay opaque. */
import type { Values } from "./sync.ts";
import type * as Sdk from "@unbrained/pm-cli/sdk";
import { stripTrailingSlashes, CommandError, EXIT_CODE } from "./index.ts";
import { loadResolutionSdk } from "./resolution.ts";

/** Native SDK and tracker schema used by both projection and persistence. */
export interface ValueNormalization {
  /** Host-owned namespace, preserving extension registration identity. */
  sdk: typeof Sdk;
  /** Configured runtime schema; unknown historical statuses retain their raw value. */
  schema: Sdk.PmSettings["schema"];
  /** Configured prefix for operator item references. */
  idPrefix: string;
}
let defaultSdk: typeof Sdk | undefined;
/** Load the existing SDK bridge only when a caller has not supplied its native context. */
function native(context?: ValueNormalization): typeof Sdk { return context?.sdk ?? (defaultSdk ??= loadResolutionSdk()); }
/** Canonical statuses resolved by native host schema reads without a module link. */
export interface StatusReferenceNormalization {
  /** Resolve only values certified by the host SDK registry. */
  resolveStatus(value: string): string;
}
/** Resolve lifecycle aliases through the same SDK registry used by native updates. */
export function normalizeStatusValue(value: string, context?: ValueNormalization | StatusReferenceNormalization): string {
  if (context !== undefined && "resolveStatus" in context) return context.resolveStatus(value);
  const sdk = native(context);
  return context === undefined ? sdk.normalizeStatusInput(value) ?? value : sdk.normalizeStatusForRegistry(value, sdk.resolveRuntimeStatusRegistry(context.schema));
}
/** Canonical identities resolved by native host reads when no SDK module link exists. */
export interface ItemReferenceNormalization {
  /** Resolve only references already certified by the host SDK client. */
  resolveReference(value: string): string;
}
/** Canonical operator IDs use native SDK resolution, case, hash-marker and prefix rules. */
export function normalizeItemReference(value: string, context?: ValueNormalization | ItemReferenceNormalization): string {
  if (context !== undefined && "resolveReference" in context) return context.resolveReference(value);
  const sdk = native(context);
  return context === undefined ? sdk.normalizeRawItemId(value) : sdk.normalizeItemId(value, context.idPrefix);
}
/** Host-owned text normalization for metadata discovery without a package SDK module link. */
export interface TitleReferenceNormalization {
  /** Project the exact required text value used by the export writer. */
  resolveTitle(value: string): string;
}
/** Resolvers available to metadata-only discovery; absent text rules fall back to writer-matching trims. */
export type DiscoveryNormalization = StatusReferenceNormalization & Partial<TitleReferenceNormalization>;
/** Required text shares SDK trimming; the fallback stays SDK-free for metadata-only discovery. */
export function normalizeTitleValue(value: string, context?: ValueNormalization | Partial<TitleReferenceNormalization>): string {
  if (context !== undefined && "sdk" in context) return context.sdk.toNonEmptyImportString(value) ?? "";
  return context?.resolveTitle?.(value) ?? (typeof value === "string" ? value.trim() : "");
}
/** Legacy scalar clear tokens have the same meaning as the SDK's explicit unset path. */
function clearToken(value: string): boolean { return ["none", "null"].includes(value.trim().toLowerCase()); }
/** Assignment names preserve case while sharing SDK trimming and legacy scalar-clear semantics. */
export function normalizeAssigneeValue(value: string, context?: ValueNormalization): string {
  return clearToken(value) ? "" : native(context).toNonEmptyImportString(value) ?? "";
}
/** SDK tag normalization precedes the existing locale-independent set comparison order. */
export function normalizeTagValues(value: readonly string[], context?: ValueNormalization): string[] { return native(context).toImportTags([...value]).sort(); }
/** Numeric SDK priorities retain invalid historical values for evaluation; native writes still validate them. */
export function normalizePriorityValue(value: string | number, context?: ValueNormalization): string | number {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 4 ? native(context).toImportPriority(number) : value;
}
/** Provider classification text is literal: SDK custom-field writes preserve its case, whitespace and Unicode. */
export function normalizeLiteralValue(value: string): string { return value; }
/** Scope uses the same trimming and organization trailing-slash rule as package configuration writes. */
export function normalizeScopeValue(value: string, organization = false): string { return organization ? stripTrailingSlashes(value.trim()) : value.trim(); }
/**
 * True when an item's stored Azure scope equals the configured scope after normalization. Every scope check calls
 * this, so sparse refresh, move preview, resolution and sync cannot drift apart.
 *
 * The one deliberate difference is how an item without `ado_org_url` is treated, and callers state it explicitly:
 * `"refuse"` (refresh, resolution, moves) requires the stored organization; `"match"` (sync's identity and agreement
 * reads) accepts items imported before `ado_org_url` was recorded as belonging to the configured organization.
 *
 * @param item - The item's stored scope fields.
 * @param config - The configured organization URL and project.
 * @param missingOrganization - How to treat an item that has no stored organization URL.
 * @returns Whether the item belongs to the configured scope.
 */
export function sameScope(item: Readonly<Record<string, unknown>>, config: { readonly orgUrl: string; readonly project: string }, missingOrganization: "match" | "refuse"): boolean {
  const organization = item.ado_org_url === undefined && missingOrganization === "match"
    || normalizeScopeValue(String(item.ado_org_url ?? ""), true) === normalizeScopeValue(config.orgUrl, true);
  return organization && normalizeScopeValue(String(item.ado_project ?? "")) === normalizeScopeValue(config.project);
}
/** Normalize only mapped semantic fields, retaining unknown coordinates and partial-base markers verbatim. */
export function normalizeFieldValues(values: Readonly<Values>, context?: ValueNormalization): Values {
  const result = { ...values };
  for (const [field, value] of Object.entries(values)) {
    if (field === "status" && typeof value === "string") result[field] = normalizeStatusValue(value, context);
    if (field === "title" && typeof value === "string") result[field] = normalizeTitleValue(value, context);
    if (field === "description" && typeof value === "string") result[field] = normalizeLiteralValue(value);
    if (field === "assignee" && typeof value === "string") result[field] = normalizeAssigneeValue(value, context);
    if (field === "priority" && (typeof value === "string" || typeof value === "number")) result[field] = normalizePriorityValue(value, context);
    if ((field === "ado_area_path" || field === "ado_iteration_path") && typeof value === "string") result[field] = normalizeLiteralValue(value);
    if (field === "tags" && Array.isArray(value)) result[field] = normalizeTagValues(value, context);
  }
  return result;
}
/** Normalize every mapped scalar for discovery checks; a full context uses writer-exact semantics. */
export function normalizeDiscoveryFieldValues(values: Readonly<Values>, context?: ValueNormalization | DiscoveryNormalization): Values {
  if (context !== undefined && "sdk" in context) return normalizeFieldValues(values, context);
  const result = { ...values };
  if (typeof result.status === "string") result.status = normalizeStatusValue(result.status, context);
  if (typeof result.title === "string") result.title = normalizeTitleValue(result.title, context);
  // The SDK-free projections mirror the writer's trimming, clear tokens and sorted labels so
  // required/allowed discovery cannot diverge from the actual export write.
  if (typeof result.assignee === "string") result.assignee = clearToken(result.assignee) ? "" : result.assignee.trim();
  if (Array.isArray(result.tags)) result.tags = [...new Set(result.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].sort();
  if (typeof result.priority === "string" || typeof result.priority === "number") {
    const number = Number(result.priority);
    if (Number.isInteger(number) && number >= 0 && number <= 4) result.priority = number;
  }
  return result;
}
/** Canonicalize mapping interpretation without changing Azure's literal state names or inherited-key safety. */
export function normalizeStateMaps(maps: { imports: Readonly<Record<string, string>>; exports: Readonly<Record<string, string>> }, context?: ValueNormalization | StatusReferenceNormalization) {
  const imports = Object.fromEntries(Object.entries(maps.imports).map(([key, value]) => [key, normalizeStatusValue(value, context)]));
  const exports: Record<string, string> = {};
  for (const [key, value] of Object.entries(maps.exports)) {
    const canonical = normalizeStatusValue(key, context);
    // Two SDK-equivalent status keys mapping to different Azure states are ambiguous;
    // refusing beats silently discarding one mapping and choosing an arbitrary state.
    if (Object.hasOwn(exports, canonical) && exports[canonical] !== value) {
      throw new CommandError(`Ambiguous status export mapping for ${canonical}: ${key} and a prior key map to different Azure states`, EXIT_CODE.usage);
    }
    Object.defineProperty(exports, canonical, { value, enumerable: true, writable: true, configurable: true });
  }
  return { imports, exports };
}
