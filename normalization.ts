/** Shared field representations for SDK writes and semantic comparison; raw guards stay opaque. */
import type { Values } from "./sync.ts";
import type * as Sdk from "@unbrained/pm-cli/sdk";
import { stripTrailingSlashes } from "./index.ts";
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
/** Canonicalize mapping interpretation without changing Azure's literal state names or inherited-key safety. */
export function normalizeStateMaps(maps: { imports: Readonly<Record<string, string>>; exports: Readonly<Record<string, string>> }, context?: ValueNormalization | StatusReferenceNormalization) {
  return { imports: Object.fromEntries(Object.entries(maps.imports).map(([key, value]) => [key, normalizeStatusValue(value, context)])),
    exports: Object.fromEntries(Object.entries(maps.exports).map(([key, value]) => [normalizeStatusValue(key, context), value])) };
}
