/** Read-back witnesses for advancing only fields that both stores actually share. */
import { CommandError, EXIT_CODE } from "./index.js";
/** Advance each key only from matching post-operation reads; acknowledge a revision only on full agreement. */
export async function advanceSyncBase(operations) {
    const local = await operations.readLocal();
    if (local.version !== operations.expectedVersion)
        throw new CommandError("Local item changed before read-back agreement; re-read both trackers and retry", EXIT_CODE.conflict);
    const remote = await operations.readRemote(local);
    const keys = [...new Set([...Object.keys(local.values), ...Object.keys(remote.values)])];
    const base = {};
    const differences = [];
    for (const key of keys) {
        if (JSON.stringify(local.values[key]) === JSON.stringify(remote.values[key]))
            base[key] = structuredClone(local.values[key]);
        else {
            differences.push(key);
            if (local.base !== undefined && Object.hasOwn(local.base, key))
                base[key] = structuredClone(local.base[key]);
        }
    }
    // A versioned partial base distinguishes unknown keys from corrupt legacy JSON.
    if (Object.keys(base).length !== keys.length)
        base.ado_base_partial = 1;
    await operations.publish(base, differences.length === 0 ? remote.revision : undefined, local.version);
    return { base, differences, local, remote };
}
//# sourceMappingURL=agreement.js.map