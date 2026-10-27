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
/** Required text follows SDK trimming, retaining empty/invalid legacy values for read-only evaluation. */
export function normalizeTitleValue(value, context) { return native(context).toNonEmptyImportString(value) ?? ""; }
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