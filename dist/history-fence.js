import { randomUUID } from "node:crypto";
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
    /** Stable forward-only class alongside the compatible CLI envelope. */
    kind = "sync_conflict";
    /** Canonical local target, when a guarded write has selected one. */
    item;
    /** Saved and current field values; null represents an absent field. */
    fields;
    /** Return a structured, forward-only conflict without rewriting either writer's work. */
    constructor(item = null, fields = {}) {
        super("Local sync state changed; re-read both trackers and re-plan from current tracker state.");
        this.item = item;
        this.fields = fields;
    }
}
/** Use the SDK's native record chain as the only local revision witness. */
export async function nativeHead(sdk, pmRoot, id) {
    const { entries } = await sdk.readHistorySnapshot(sdk.getHistoryPath(pmRoot, id), id);
    const last = entries.at(-1);
    return { length: entries.length, hash: last === undefined ? "empty" : last.record_hash ?? sdk.hashHistoryRecord(last) };
}
/** Inspect native state before each write and detect intervening events without compensation. */
export class NativeWriteFence {
    heads = new Map();
    snapshots = new Map();
    /** Upper bound from final revision read to the latest SDK write completing, in milliseconds. */
    lastWriteWindowMs = 0;
    /** Bind real SDK lifecycle operations; the optional dispatch also supports host-owned adapters. */
    sdk;
    pmRoot;
    author;
    write;
    /** Bind SDK operations without replacing their hierarchy or permission validation. */
    constructor(sdk, pmRoot, author, write) {
        this.sdk = sdk;
        this.pmRoot = pmRoot;
        this.author = author;
        this.write = write ?? ((id, options) => sdk.update(id, options, { pmRoot }));
    }
    /** Read authoritative normalized fields through settings-aware SDK location. */
    async document(id) {
        const settings = await this.sdk.readSettings(this.pmRoot);
        const located = await this.sdk.locateItem(this.pmRoot, id, settings.id_prefix, settings.item_format, this.sdk.resolveItemTypeRegistry(settings, this.sdk.getActiveExtensionRegistrations()).type_to_folder);
        if (located === null)
            throw new NativeHistoryConflict(id, { item: { base: "present", current: null } });
        return (await this.sdk.readLocatedItem(located, { schema: settings.schema })).document;
    }
    /** Capture current state for a new plan; abandoned journals never replay old writes. */
    async capture(id) {
        const head = await nativeHead(this.sdk, this.pmRoot, id), document = await this.document(id);
        this.heads.set(id, head);
        this.snapshots.set(id, document);
    }
    /** Bind a newly created item to its SDK birth receipt rather than adopting a later peer edit. */
    async captureCreated(created) {
        const { entries } = await this.sdk.readHistorySnapshot(this.sdk.getHistoryPath(this.pmRoot, created.id), created.id);
        const birth = entries[0];
        if (birth?.op !== "create")
            throw new NativeHistoryConflict(created.id);
        const document = this.sdk.replayToItemDocument(this.sdk.replayHistoryToTarget(entries, 0));
        if (!this.sdk.stableValueEquals(document.metadata, created))
            throw new NativeHistoryConflict(created.id);
        this.snapshots.set(created.id, document);
        this.heads.set(created.id, { length: 1, hash: birth.record_hash ?? this.sdk.hashHistoryRecord(birth) });
        await this.assertCurrent(created.id);
    }
    /** Copy the portable native coordinate used by resolution plans. */
    head(id) { return { ...this.heads.get(id) }; }
    /** Build field evidence from saved and current SDK-normalized documents. */
    conflict(id, current, keys) {
        const previous = this.snapshots.get(id);
        const before = new Map(Object.entries({ ...previous.metadata, body: previous.body }));
        const after = new Map(Object.entries({ ...current.metadata, body: current.body }));
        const fields = Object.fromEntries((keys ?? [...new Set([...before.keys(), ...after.keys()])]).filter((key) => key !== "updated_at" &&
            !this.sdk.stableValueEquals(before.get(key), after.get(key))).map((key) => [key, { base: before.get(key) ?? null, current: after.get(key) ?? null }]));
        return new NativeHistoryConflict(id, fields);
    }
    /** Refuse advanced native history, including fixed-clock ABA, without any reverse mutation. */
    async assertCurrent(id) {
        const current = await nativeHead(this.sdk, this.pmRoot, id), expected = this.heads.get(id);
        if (expected === undefined)
            throw new NativeHistoryConflict(id, { history: { base: null, current } });
        if (current.length !== expected.length || current.hash !== expected.hash) {
            const conflict = this.conflict(id, await this.document(id));
            if (!Object.keys(conflict.fields).length)
                conflict.fields.history = { base: expected, current };
            throw conflict;
        }
    }
    /** Recheck every captured head so query limits and filters never narrow the fence. */
    async assertAll() {
        for (const id of [...this.heads.keys()])
            await this.assertCurrent(id);
    }
    /** Compare SDK-planned effects with only SDK-declared commit-time values masked, preserving field presence. */
    plannedEquals(left, right, clocks) {
        /** SDK patches work on disposable copies, including nested dependency/log timestamps. */
        const fields = (document) => this.sdk.applyHistoryPatch(structuredClone({
            metadata: this.sdk.toItemRecord(document.metadata), body: document.body
        }), clocks.map((pointer) => ({ op: "replace", path: `/metadata${pointer}`, value: "native-clock" })), 0, "preview");
        try {
            return this.sdk.stableValueEquals(fields(left), fields(right));
        }
        catch {
            return false; /* A missing planned field is a different mutation, not a clock value. */
        }
    }
    /** Ask the real SDK apply planner for canonical state, including its own option normalization. */
    async plannedDocument(id, options) {
        const request = { transactionId: `ado-fence-${randomUUID()}`, mutations: [{ op: "update", id, options }] };
        const client = new this.sdk.PmClient({ pmRoot: this.pmRoot, author: this.author });
        if (typeof client.previewItemMutations !== "function")
            return undefined;
        const preview = await client.previewItemMutations(request);
        const { body, notes_count: _notes, tests_count: _tests, collection_counts: _counts, ...metadata } = preview.records[0].item;
        return { document: this.sdk.canonicalDocument({ metadata: metadata, body: body }, { schema: (await this.sdk.readSettings(this.pmRoot)).schema }), clocks: preview.records[0].commit_time_fields };
    }
    /** Bind every accepted event to the intended SDK mutation, including its message-less pre-close phase. */
    async mutationPlan(id, options) {
        const plan = { phases: [], complete: false, legacy: false, closing: false };
        let previous = this.snapshots.get(id);
        try {
            const settings = await this.sdk.readSettings(this.pmRoot), registry = this.sdk.resolveRuntimeStatusRegistry(settings.schema);
            plan.closing = options.status !== undefined && this.sdk.normalizeStatusForRegistry(options.status, registry) === registry.close_status;
            if (plan.closing) {
                // This is the SDK's routed pre-close invocation, planned by the same SDK writer.
                const partial = await this.plannedDocument(id, { ...options, status: undefined, closeReason: undefined, message: undefined });
                if (partial === undefined)
                    plan.legacy = true;
                else if (!this.plannedEquals(previous, partial.document, ["/updated_at"])) {
                    plan.phases.push({ ...partial, partial: true });
                    previous = partial.document;
                }
            }
            if (!plan.legacy) {
                const document = await this.plannedDocument(id, options);
                if (document === undefined)
                    plan.legacy = true;
                else {
                    if (!this.plannedEquals(previous, document.document, ["/updated_at"]))
                        plan.phases.push({ ...document, partial: false });
                    plan.complete = true;
                }
            }
        }
        catch { /* Dispatch preserves the native validation error; an unverified success never advances the baseline. */ }
        await this.assertCurrent(id);
        const current = await this.document(id);
        if (!this.sdk.stableValueEquals(current, this.snapshots.get(id)))
            throw this.conflict(id, current);
        return plan;
    }
    /** Bind effects to an unmodified native SDK receipt, including peers that make the owned write a no-op. */
    receiptOwned(id, suffix, current, message, closing, result, failed) {
        if (failed || suffix.length === 0)
            return suffix.length === 0;
        if (typeof result !== "object" || result === null)
            return false;
        const receipt = result;
        if (!Array.isArray(receipt.changed_fields) || !receipt.changed_fields.every((key) => typeof key === "string") ||
            typeof receipt.item !== "object" || receipt.item === null || receipt.item.id !== id)
            return false;
        const fields = new Set(receipt.changed_fields);
        if (suffix.length > (fields.size === 0 ? 0 : closing ? 2 : 1))
            return false;
        if (suffix.some((entry, index) => {
            const changes = entry.patch.filter((patch) => patch.path !== "/metadata/updated_at");
            return (entry.message !== message && !(closing && index === 0 && entry.op === "update" && entry.message === undefined)) ||
                changes.length === 0 || changes.some((patch) => !fields.has((patch.path.startsWith("/metadata/") ? patch.path.slice(10) : patch.path.slice(1))
                .split("/")[0].replaceAll("~1", "/").replaceAll("~0", "~")));
        }))
            return false;
        try {
            const { body: _body, ...metadata } = receipt.item;
            return this.sdk.stableValueEquals(current.metadata, this.sdk.canonicalDocument({ metadata: metadata, body: current.body }).metadata);
        }
        catch {
            return false;
        }
    }
    /** Verify the exact planned record sequence and current document without adopting a peer event. */
    async writtenState(id, expected, message, operation, plan, failed = false, result) {
        const { entries } = await this.sdk.readHistorySnapshot(this.sdk.getHistoryPath(this.pmRoot, id), id);
        const current = await this.document(id);
        const suffix = entries.slice(expected.length);
        const document = suffix.length ? this.sdk.replayToItemDocument(this.sdk.replayHistoryToTarget(entries, entries.length - 1)) : this.snapshots.get(id);
        const attributionMismatch = suffix.some((entry) => entry.author !== this.author || entry.agent_provenance?.ado_operation?.value !== operation);
        if (attributionMismatch || (!failed || plan.legacy) && !this.receiptOwned(id, suffix, current, message, plan.closing, result, failed) || (!plan.legacy && (suffix.length > plan.phases.length || !failed && (suffix.length > 0 && !plan.complete || suffix.length !== plan.phases.length) ||
            suffix.some((entry, index) => (entry.message !== message && !(plan.phases[index].partial && entry.message === undefined && entry.op === "update")) ||
                !this.plannedEquals(this.sdk.replayToItemDocument(this.sdk.replayHistoryToTarget(entries, expected.length + index)), plan.phases[index].document, plan.phases[index].clocks)))) ||
            !this.sdk.stableValueEquals(current, document)) {
            const conflict = this.conflict(id, current);
            if (!Object.keys(conflict.fields).length)
                conflict.fields.history = { base: expected, current: await nativeHead(this.sdk, this.pmRoot, id) };
            throw conflict;
        }
        const last = entries.at(-1);
        return { current, head: { length: entries.length, hash: last === undefined ? "empty" : last.record_hash ?? this.sdk.hashHistoryRecord(last) } };
    }
    /** Re-read changed fields, write forward once, and report races without restoring anything. */
    async update(id, options, transactionId) {
        if (!this.snapshots.has(id))
            throw new NativeHistoryConflict(id);
        const keys = [...Object.keys(options).filter((key) => !["field", "unset", "dep", "message", "author", "force"].includes(key)),
            ...(options.field ?? []).map((field) => field.split("=")[0]), ...(options.unset ?? []),
            ...(options.dep !== undefined || options.clearDeps || options.replaceDeps ? ["dependencies"] : []), ...(options.status !== undefined ? ["assignee"] : [])];
        const conflict = this.conflict(id, await this.document(id), keys);
        if (Object.keys(conflict.fields).length)
            throw conflict;
        await this.assertCurrent(id);
        const expected = this.heads.get(id);
        const message = `bulk-item-transaction ${transactionId} apply${options.message === undefined ? "" : `; ${options.message}`}`;
        // Bind to the decision document, never a later revision read that could adopt a peer edit.
        // Older supported hosts retain their documented history-detection-only behavior.
        const plan = await this.mutationPlan(id, options);
        const readAt = performance.now();
        let unchecked = false, result;
        const operation = randomUUID();
        try {
            const dispatch = async () => { result = await this.write(id, { ...options, author: this.author, message }); return result; };
            const write = () => this.sdk.runWithAgentSessionContext({ provenance: { ado_operation: operation } }, dispatch);
            if (typeof this.sdk.withExpectedItemRevisions === "function") {
                const receipt = await this.sdk.withExpectedItemRevisions([{ id, itemHash: this.sdk.hashDocument(this.snapshots.get(id)) }], write, { pmRoot: this.pmRoot });
                unchecked = receipt.unchecked.length > 0;
            }
            else
                await write();
        }
        catch (error) {
            try {
                const { current } = await this.writtenState(id, expected, message, operation, plan, true, result);
                if (typeof this.sdk.isItemRevisionConflict === "function" && this.sdk.isItemRevisionConflict(error))
                    throw this.conflict(id, current);
            }
            catch (stateError) {
                if (stateError instanceof NativeHistoryConflict)
                    throw stateError;
            }
            throw error;
        }
        finally {
            this.lastWriteWindowMs = performance.now() - readAt;
        }
        if (unchecked) {
            const conflict = this.conflict(id, await this.document(id));
            conflict.message = "Native dispatch completed without a revision check; re-read both trackers and re-plan from current tracker state.";
            throw conflict;
        }
        const { current, head } = await this.writtenState(id, expected, message, operation, plan, false, result);
        this.snapshots.set(id, current);
        this.heads.set(id, head);
        await this.assertCurrent(id);
        return current.metadata.updated_at;
    }
}
//# sourceMappingURL=history-fence.js.map