/** Validate portable witnesses, including a legacy tracker with no native history yet. */
export function isNativeHead(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    const head = value;
    return Number.isSafeInteger(head.length) && Number(head.length) >= 0 &&
        (head.length === 0 ? head.hash === "empty" : typeof head.hash === "string" && /^[a-f0-9]{64}$/u.test(head.hash));
}
/** A peer edit invalidated the inspected plan, including an ABA edit. */
export class NativeHistoryConflict extends Error {
    exitCode = 4;
    code = "ADO_CONFLICT";
    /** Return a stable refusal without leaking item content. */
    constructor() { super("Native item history advanced; re-read both trackers and retry."); }
}
/** Use the SDK's native record chain as the only local revision witness. */
export async function nativeHead(sdk, pmRoot, id) {
    const { entries } = await sdk.readHistorySnapshot(sdk.getHistoryPath(pmRoot, id), id);
    const last = entries.at(-1);
    return { length: entries.length, hash: last === undefined ? "empty" : last.record_hash ?? sdk.hashHistoryRecord(last) };
}
/** Apply later native peer set edits to the state before the stale write, using SDK value equality. */
function preservePeerCollection(sdk, before, own, latest) {
    const result = before.filter((value) => !own.some((entry) => sdk.stableValueEquals(entry, value)) || latest.some((entry) => sdk.stableValueEquals(entry, value)));
    for (const value of latest)
        if (!own.some((entry) => sdk.stableValueEquals(entry, value)) && !result.some((entry) => sdk.stableValueEquals(entry, value)))
            result.push(structuredClone(value));
    return result;
}
/** Capture before inspecting, then carry only verified own revisions between writes. */
export class NativeWriteFence {
    heads = new Map();
    sdk;
    pmRoot;
    author;
    write;
    onTransition;
    journals = new Map();
    inspectedJournals = false;
    /** Bind the host SDK without replacing extensions, hooks or lifecycle policy. */
    constructor(sdk, pmRoot, author, write, onTransition) {
        this.sdk = sdk;
        this.pmRoot = pmRoot;
        this.author = author;
        this.write = write ?? ((id, options) => sdk.update(id, options, { pmRoot }));
        this.onTransition = onTransition;
    }
    /** Recover interrupted verifications before a fresh inspection of this item. */
    async capture(id) {
        if (!this.inspectedJournals) {
            const inspection = await this.sdk.runWorkspaceTransactionGc(this.pmRoot, { dryRun: true, retentionDays: Infinity });
            for (const journal of inspection.entries)
                this.journals.set(journal.file, journal.status);
            this.inspectedJournals = true;
        }
        const history = (await this.sdk.readHistorySnapshot(this.sdk.getHistoryPath(this.pmRoot, id), id)).entries;
        for (const entry of history) {
            const marker = entry.message?.match(/^bulk-item-transaction (\S+) native-fence:(\d+):([a-zA-Z0-9_-]+) apply$/u);
            if (marker === undefined || marker === null)
                continue;
            const expected = { length: Number(marker[2]), hash: marker[3] };
            const journal = `transactions/sdk/${this.journalId(marker[1], expected)}.json`;
            if (this.journals.get(journal) === "committed" && history.some((event) => event.context?.ado_native_write === entry.record_hash))
                continue;
            await this.commit(id, {}, marker[1], expected, entry.author);
        }
        this.heads.set(id, await nativeHead(this.sdk, this.pmRoot, id));
    }
    /** Expose a copy for portable plans and locked preflight checks. */
    head(id) { return { ...this.heads.get(id) }; }
    /** Refuse a read-back whose native history advanced even when no publication is needed. */
    async assertCurrent(id) {
        const current = await nativeHead(this.sdk, this.pmRoot, id), expected = this.heads.get(id);
        if (current.length !== expected?.length || current.hash !== expected.hash)
            throw new NativeHistoryConflict();
    }
    /** Commit a native SDK update, then verify or selectively compensate inside its workspace transaction. */
    async update(id, options, transactionId) {
        const expected = this.heads.get(id);
        if (expected === undefined)
            throw new NativeHistoryConflict();
        await this.assertCurrent(id);
        return this.commit(id, options, transactionId, expected, this.author);
    }
    /** Bind SDK journal identity to the immutable inspected head, independent of timestamps. */
    journalId(transactionId, expected) {
        return `${transactionId}-${this.sdk.deriveMutationTransactionId(JSON.stringify(expected))}`;
    }
    /** Replay the exact native marker after a crash; the SDK owns transaction journaling and lifecycle writes. */
    async commit(id, options, transactionId, expected, author) {
        const sdk = this.sdk, pmRoot = this.pmRoot;
        const message = `bulk-item-transaction ${transactionId} native-fence:${expected.length}:${expected.hash} apply`;
        let conflict = false;
        let version = "";
        /** Verify the actual native author, operation and immutable patch under the same lease as compensation. */
        const verify = async (compensate = false) => {
            const settings = await sdk.readSettings(pmRoot);
            const entries = (await sdk.readHistorySnapshot(sdk.getHistoryPath(pmRoot, id), id)).entries;
            const index = entries.findIndex((entry) => entry.message === message && entry.author === author);
            if (index < 0)
                throw new NativeHistoryConflict();
            const own = entries[index];
            const verified = entries.map((entry) => entry.context?.ado_native_write === own.record_hash).lastIndexOf(true);
            if (verified >= 0 && (!compensate || entries[verified].context?.ado_native_conflict === true)) {
                conflict = entries[verified].context?.ado_native_conflict === true;
                version = entries[verified].ts;
                this.heads.set(id, { length: verified + 1, hash: entries[verified].record_hash });
                return true;
            }
            const context = { ado_native_write: own.record_hash, ado_native_conflict: false };
            await sdk.mutateItemWithHistoryContext({ pmRoot, settings, id, author, op: "update", bypassAssigneeConflict: true,
                message: "Verify native Azure mutation", historyContext: context,
                mutate: async (document) => {
                    const history = (await sdk.readHistorySnapshot(sdk.getHistoryPath(pmRoot, id), id)).entries;
                    const actualIndex = history.findIndex((entry) => entry.record_hash === own.record_hash);
                    const prior = history[expected.length - 1];
                    conflict = compensate || actualIndex !== expected.length || (prior !== undefined && (prior.record_hash ?? sdk.hashHistoryRecord(prior)) !== expected.hash) ||
                        history.length !== expected.length + 1 || !["update", "close", "reopen"].includes(own.op);
                    context.ado_native_conflict = conflict;
                    if (!conflict)
                        return { changedFields: [] };
                    // SDK replay verifies the immutable patch and reconstructs the actual peer state immediately before our write.
                    const before = sdk.replayHistoryToTarget(history, actualIndex - 1);
                    const afterOwn = sdk.applyHistoryPatch(structuredClone(before), own.patch, actualIndex + 1, own.op);
                    const fields = new Set(own.patch.map((patch) => patch.path.split("/").slice(0, 3).join("/")));
                    const later = new Set(history.slice(actualIndex + 1).flatMap((entry) => entry.patch.map((patch) => patch.path.split("/").slice(0, 3).join("/"))));
                    const changedFields = [];
                    for (const path of fields) {
                        const key = path.split("/")[2];
                        if (later.has(path)) {
                            if (key === "tags" || key === "dependencies") {
                                Object.assign(document.metadata, { [key]: preservePeerCollection(sdk, (before.metadata[key] ?? []), (afterOwn.metadata[key] ?? []), (document.metadata[key] ?? [])) });
                                changedFields.push(key);
                            }
                            continue; // Later native scalar values remain authoritative.
                        }
                        if (path === "/body") {
                            document.body = before.body;
                            changedFields.push("body");
                            continue;
                        }
                        if (Object.hasOwn(before.metadata, key))
                            document.metadata[key] = structuredClone(before.metadata[key]);
                        else
                            delete document.metadata[key];
                        changedFields.push(key);
                    }
                    return { changedFields };
                } });
            const after = (await sdk.readHistorySnapshot(sdk.getHistoryPath(pmRoot, id), id)).entries;
            const receipt = after.map((entry) => entry.context?.ado_native_write === own.record_hash).lastIndexOf(true);
            version = after[receipt].ts;
            this.heads.set(id, { length: receipt + 1, hash: after[receipt].record_hash });
            return true;
        };
        const journalId = this.journalId(transactionId, expected);
        await sdk.commitWorkspaceTransaction({ pmRoot, author, onTransition: this.onTransition,
            transactionId: journalId, steps: [{ id: "native-write",
                    inspect: async () => {
                        const history = (await sdk.readHistorySnapshot(sdk.getHistoryPath(pmRoot, id), id)).entries;
                        const own = history.find((entry) => entry.message === message && entry.author === author);
                        const receipt = own === undefined ? -1 : history.map((entry) => entry.context?.ado_native_write === own.record_hash).lastIndexOf(true);
                        if (receipt < 0)
                            return { state: "pending" };
                        conflict = history[receipt].context?.ado_native_conflict === true;
                        version = history[receipt].ts;
                        this.heads.set(id, { length: receipt + 1, hash: history[receipt].record_hash });
                        return { state: "applied", result: { conflict } };
                    },
                    apply: async () => {
                        const history = (await sdk.readHistorySnapshot(sdk.getHistoryPath(pmRoot, id), id)).entries;
                        if (!history.some((entry) => entry.message === message && entry.author === author)) {
                            try {
                                await this.write(id, { ...options, author, message });
                            }
                            catch (error) {
                                const failed = (await sdk.readHistorySnapshot(sdk.getHistoryPath(pmRoot, id), id)).entries;
                                if (failed.some((entry) => entry.message === message && entry.author === author)) {
                                    await verify();
                                    if (conflict)
                                        return { conflict };
                                }
                                else {
                                    const current = await nativeHead(sdk, pmRoot, id);
                                    if (current.length !== expected.length || current.hash !== expected.hash)
                                        throw new NativeHistoryConflict();
                                }
                                throw error;
                            }
                            const after = (await sdk.readHistorySnapshot(sdk.getHistoryPath(pmRoot, id), id)).entries;
                            if (!after.some((entry) => entry.message === message && entry.author === author)) {
                                // Native update deliberately omits history for an equivalent value. Give that successful no-op a locked witness.
                                await sdk.mutateItemWithHistoryContext({ pmRoot, settings: await sdk.readSettings(pmRoot), id, author, op: "update",
                                    message, bypassAssigneeConflict: true, skipNoop: false, historyContext: { ado_native_noop: true },
                                    mutate: async () => {
                                        const current = await nativeHead(sdk, pmRoot, id);
                                        if (current.length !== expected.length || current.hash !== expected.hash)
                                            throw new NativeHistoryConflict();
                                        return { changedFields: [] };
                                    } });
                            }
                        }
                        await verify();
                        return { conflict };
                    },
                    compensate: async () => { await verify(true); }, }] });
        this.journals.set(`transactions/sdk/${journalId}.json`, "committed");
        // A committed journal may replay without invoking its steps; immutable verification remains authoritative.
        await verify();
        if (conflict)
            throw new NativeHistoryConflict();
        await this.assertCurrent(id);
        return version;
    }
}
//# sourceMappingURL=history-fence.js.map