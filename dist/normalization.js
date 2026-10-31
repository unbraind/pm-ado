import { stripTrailingSlashes } from "./index.js";
import { loadResolutionSdk } from "./resolution.js";
let defaultSdk;
/** Load the existing SDK bridge only when a caller has not supplied its native context. */
function native(context) { return context?.sdk ?? (defaultSdk ??= loadResolutionSdk()); }
/** Resolve lifecycle aliases through the same SDK registry used by native updates. */
export function normalizeStatusValue(value, context) {
    if (context !== undefined && "resolveStatus" in context)
        return context.resolveStatus(value);
    const sdk = native(context);
    return context === undefined ? sdk.normalizeStatusInput(value) ?? value : sdk.normalizeStatusForRegistry(value, sdk.resolveRuntimeStatusRegistry(context.schema));
}
/** Canonical operator IDs use native SDK resolution, case, hash-marker and prefix rules. */
export function normalizeItemReference(value, context) {
    if (context !== undefined && "resolveReference" in context)
        return context.resolveReference(value);
    const sdk = native(context);
    return context === undefined ? sdk.normalizeRawItemId(value) : sdk.normalizeItemId(value, context.idPrefix);
}
/** Required text shares SDK trimming; the fallback stays SDK-free for metadata-only discovery. */
export function normalizeTitleValue(value, context) {
    if (context !== undefined && "sdk" in context)
        return context.sdk.toNonEmptyImportString(value) ?? "";
    return context?.resolveTitle?.(value) ?? (typeof value === "string" ? value.trim() : "");
}
/** Legacy scalar clear tokens have the same meaning as the SDK's explicit unset path. */
function clearToken(value) { return ["none", "null"].includes(value.trim().toLowerCase()); }
/** Assignment names preserve case while sharing SDK trimming and legacy scalar-clear semantics. */
export function normalizeAssigneeValue(value, context) {
    return clearToken(value) ? "" : native(context).toNonEmptyImportString(value) ?? "";
}
/** SDK tag normalization precedes the existing locale-independent set comparison order. */
export function normalizeTagValues(value, context) { return native(context).toImportTags([...value]).sort(); }
/** Numeric SDK priorities retain invalid historical values for evaluation; native writes still validate them. */
export function normalizePriorityValue(value, context) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 && number <= 4 ? native(context).toImportPriority(number) : value;
}
/** Provider classification text is literal: SDK custom-field writes preserve its case, whitespace and Unicode. */
export function normalizeLiteralValue(value) { return value; }
/** Scope uses the same trimming and organization trailing-slash rule as package configuration writes. */
export function normalizeScopeValue(value, organization = false) { return organization ? stripTrailingSlashes(value.trim()) : value.trim(); }
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
export function sameScope(item, config, missingOrganization) {
    const organization = item.ado_org_url === undefined && missingOrganization === "match"
        || normalizeScopeValue(String(item.ado_org_url ?? ""), true) === normalizeScopeValue(config.orgUrl, true);
    return organization && normalizeScopeValue(String(item.ado_project ?? "")) === normalizeScopeValue(config.project);
}
/** Normalize only mapped semantic fields, retaining unknown coordinates and partial-base markers verbatim. */
export function normalizeFieldValues(values, context) {
    const result = { ...values };
    for (const [field, value] of Object.entries(values)) {
        if (field === "status" && typeof value === "string")
            result[field] = normalizeStatusValue(value, context);
        if (field === "title" && typeof value === "string")
            result[field] = normalizeTitleValue(value, context);
        if (field === "description" && typeof value === "string")
            result[field] = normalizeLiteralValue(value);
        if (field === "assignee" && typeof value === "string")
            result[field] = normalizeAssigneeValue(value, context);
        if (field === "priority" && (typeof value === "string" || typeof value === "number"))
            result[field] = normalizePriorityValue(value, context);
        if ((field === "ado_area_path" || field === "ado_iteration_path") && typeof value === "string")
            result[field] = normalizeLiteralValue(value);
        if (field === "tags" && Array.isArray(value))
            result[field] = normalizeTagValues(value, context);
    }
    return result;
}
/** Canonicalize mapping interpretation without changing Azure's literal state names or inherited-key safety. */
export function normalizeStateMaps(maps, context) {
    return { imports: Object.fromEntries(Object.entries(maps.imports).map(([key, value]) => [key, normalizeStatusValue(value, context)])),
        exports: Object.fromEntries(Object.entries(maps.exports).map(([key, value]) => [normalizeStatusValue(key, context), value])) };
}
//# sourceMappingURL=normalization.js.map