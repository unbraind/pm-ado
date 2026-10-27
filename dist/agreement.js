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
/** Advance each key only from matching post-operation reads; acknowledge a revision only on full agreement. */
export async function advanceSyncBase(operations) {
    const local = await operations.readLocal();
    if (local.version !== operations.expectedVersion)
        throw new CommandError("Local item changed before read-back agreement; re-read both trackers and retry", EXIT_CODE.conflict);
    const remote = await operations.readRemote(local);
    const previousRevisions = readBaseRevisions(local.base);
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
            if (local.base !== undefined && Object.hasOwn(local.base, key)) {
                base[key] = structuredClone(local.base[key]);
                if (previousRevisions[key] !== undefined)
                    revisions[key] = previousRevisions[key];
            }
        }
    }
    // A versioned partial base distinguishes unknown keys from corrupt legacy JSON.
    if (Object.keys(base).length !== keys.length)
        base.ado_base_partial = 1;
    base.ado_agreed_revisions = JSON.stringify(revisions);
    await operations.publish(base, differences.length === 0 ? remote.revision : undefined, local.version);
    return { base, differences, local, remote };
}
//# sourceMappingURL=agreement.js.map