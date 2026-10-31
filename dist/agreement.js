/** Read-back witnesses for advancing only fields that both stores actually share. */
import { CommandError, EXIT_CODE } from "./index.js";
/** Decode per-key read-back revision witnesses; legacy bases have no per-key coordinates. */
export function readBaseRevisions(base) {
    if (base?.ado_agreed_revisions === undefined)
        return {};
    let revisions;
    try {
        revisions = JSON.parse(String(base.ado_agreed_revisions));
    }
    catch {
        throw new CommandError("Invalid ado_sync_base agreement revisions");
    }
    if (typeof revisions !== "object" || revisions === null || Array.isArray(revisions) ||
        Object.values(revisions).some((value) => !Number.isSafeInteger(value) || Number(value) < 1))
        throw new CommandError("Invalid ado_sync_base agreement revisions");
    return revisions;
}
/** Read explicit field membership; complete legacy bases retain their original own-field evidence. */
export function baseFields(base) {
    if (base === undefined)
        return [];
    const keys = Object.keys(base).filter((key) => !["ado_base_partial", "ado_base_fields", "ado_agreed_revisions"].includes(key) && (key !== "relations" || Array.isArray(base[key]) && base[key].every((value) => typeof value === "string")));
    if (Object.hasOwn(base, "ado_base_fields"))
        return Array.isArray(base.ado_base_fields)
            ? [...new Set(base.ado_base_fields.filter((key) => typeof key === "string" && keys.includes(key)))].sort() : [];
    return base.ado_base_partial === 1 ? [] : keys.sort();
}
/** Project only fields whose presence is certified, preserving opaque revision metadata. */
export function knownBase(base) {
    const fields = new Set(baseFields(base));
    return Object.fromEntries(Object.entries(base).filter(([key]) => fields.has(key) || ["ado_base_partial", "ado_base_fields", "ado_agreed_revisions"].includes(key)));
}
/** The same per-field revision predicate is used by hydration planning and persisted read-back evidence. */
export function fieldAtRevision(field, fields, savedRevision, observedRevision, revisions) {
    return observedRevision >= (savedRevision ?? 0) && fields.includes(field) && (revisions === undefined ? savedRevision === observedRevision : Object.hasOwn(revisions, field) && revisions[field] === observedRevision);
}
/** Advance each key only from matching post-operation reads; acknowledge a revision only on full agreement. */
export async function advanceSyncBase(operations) {
    const local = await operations.readLocal();
    if (local.version !== operations.expectedVersion)
        throw new CommandError("Local item changed before read-back agreement; re-read both trackers and retry", EXIT_CODE.conflict);
    const remote = await operations.readRemote(local);
    const previousRevisions = readBaseRevisions(local.base);
    const previousFields = new Set(baseFields(local.base));
    if (!Number.isSafeInteger(remote.revision) || remote.revision < operations.minimumRemoteRevision ||
        local.acknowledgedRevision !== undefined && remote.revision < local.acknowledgedRevision || remote.revision < Math.max(0, ...Object.values(previousRevisions))) {
        throw new CommandError("Azure read-back revision is older than the completed operation; re-read both trackers", EXIT_CODE.conflict);
    }
    const keys = [...new Set([...Object.keys(local.values), ...Object.keys(remote.values)])];
    const base = {};
    const revisions = {};
    const differences = [];
    for (const key of keys) {
        if (JSON.stringify(local.values[key]) === JSON.stringify(remote.values[key])) {
            base[key] = structuredClone(local.values[key]);
            revisions[key] = remote.revision;
        }
        else {
            differences.push(key);
            if (local.base !== undefined && previousFields.has(key)) {
                base[key] = structuredClone(local.base[key]);
                if (previousRevisions[key] !== undefined)
                    revisions[key] = previousRevisions[key];
            }
        }
    }
    // A versioned partial base distinguishes unknown keys from corrupt legacy JSON.
    if (Object.keys(base).length !== keys.length)
        base.ado_base_partial = 1;
    base.ado_base_fields = Object.keys(base).filter((key) => key !== "ado_base_partial").sort();
    base.ado_agreed_revisions = JSON.stringify(revisions);
    await operations.publish(base, differences.length === 0 ? remote.revision : undefined, local.version);
    return { base, differences, local, remote };
}
/** Build only changed agreement fields; each caller retains its own native write fence. */
export function agreementMutation(item, base, revision) {
    const field = [];
    if (item.ado_sync_base !== JSON.stringify(base))
        field.push(`ado_sync_base=${JSON.stringify(base)}`);
    if (revision !== undefined && item.ado_rev !== revision)
        field.push(`ado_rev=${revision}`);
    const unset = revision !== undefined && item.ado_sync_intent !== undefined ? ["ado_sync_intent"] : undefined;
    return { field, unset };
}
//# sourceMappingURL=agreement.js.map