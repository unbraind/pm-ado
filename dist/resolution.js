/** Portable, revision-bound decisions over the existing Azure sync field map. */
import { advanceSyncBase, readBaseRevisions } from "./agreement.js";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { AdoClient, CommandError, RevisionConflict, STATE_MAP, readConfig, buildUpdatePatch, PATCH_MEDIA_TYPE } from "./index.js";
import { ADO_FIELD_MAP, IMPORT_STATE_MAP, azureFields, localValues, readBase, remoteValues, stateMap, transport, threeWayFieldConflict, readLocalAgreement, remoteAgreement } from "./sync.js";
/** A failed decision with a concrete recovery action; server bodies are never exposed. */
export class ResolutionRefusal extends Error {
    /** Semantic conflict exit propagated by the host runtime. */
    exitCode = 4;
    /** Stable reason for refusing the decision. */
    code;
    /** Concrete recovery action for the agent. */
    remedy;
    /** Preserve the machine-readable reason and caller remedy. */
    constructor(code, remedy) {
        super(`Azure resolution refused: ${code}`);
        this.name = "ResolutionRefusal";
        this.code = code;
        this.remedy = remedy;
    }
    /** Preserve semantic refusals and map REST races without exposing service bodies. */
    static from(error) {
        if (error instanceof ResolutionRefusal)
            return error;
        if (error instanceof CommandError && error.exitCode === 2)
            return new ResolutionRefusal("configuration", "Check configured state maps and field values before generating a new plan.");
        if (typeof error === "object" && error !== null && "code" in error &&
            ["transaction_preview_non_regular_file", "transaction_preview_external_schema"].includes(String(error.code))) {
            return new ResolutionRefusal("configuration", "SDK semantic preview refuses non-regular tracker storage or external schema. Keep SDK links intact; use global pm-ado installation with its runtime outside this tracker, or an SDK supporting managed runtime exclusions.");
        }
        if (typeof error === "object" && error !== null && "code" in error &&
            ["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND"].includes(String(error.code))) {
            return new ResolutionRefusal("configuration", "Install pm-ado with pm install so the host links its SDK; standalone callers must inject their SDK into AdoResolutionService.");
        }
        if (error instanceof RevisionConflict)
            return new ResolutionRefusal("stale_remote", "Azure changed during PATCH. Generate a fresh plan; the revision assertion applied no fields.");
        return new ResolutionRefusal("apply_failed", "Inspect tracker health and Azure connectivity. Re-read both sides before retrying; an external write may have succeeded before a local failure.");
    }
}
/** Bind organization and project without storing either value or a dictionary-testable plain hash. */
export function resolutionScopeReference(config) {
    return createHmac("sha256", config.token).update(JSON.stringify([config.orgUrl, config.project])).digest("hex");
}
/** Hash recursively sorted JSON so artifact property order has no semantics. */
export function resolutionDigest(value) {
    return createHash("sha256").update(JSON.stringify(value, (_key, entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry)
        ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : 1)) : entry)).digest("hex");
}
/** Load resolution primitives from package imports or caller-supplied anchors, never inferred launcher paths. */
export function loadResolutionSdk(anchors = [import.meta.url]) {
    for (const anchor of anchors) {
        try {
            const request = createRequire(anchor);
            return request(realpathSync(request.resolve("@unbrained/pm-cli/sdk")));
        }
        catch { /* Try the next explicitly supplied package anchor. */ }
    }
    throw new ResolutionRefusal("configuration", "Install pm-ado with pm install so the host links its SDK, or supply the installed SDK explicitly to AdoResolutionService.");
}
/** Refuse malformed portable input before opening a mutation or contacting Azure. */
export function validateResolutionPlan(input) {
    if (typeof input !== "object" || input === null)
        throw new ResolutionRefusal("invalid_plan", "Generate a new plan with ado resolve-plan.");
    const p = input;
    const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
    if (p.schema !== "pm-ado/resolution/2" || !hash(p.scope?.ref) || Object.keys(p.scope).length !== 1 ||
        typeof p.local?.id !== "string" || !hash(p.local.revision) || !Number.isSafeInteger(p.remote?.id) || Number(p.remote?.id) < 1 ||
        !Number.isSafeInteger(p.remote?.revision) || Number(p.remote?.revision) < 1 || !hash(p.remote?.digest) || !hash(p.mapping) ||
        !Array.isArray(p.fields) || p.fields.length !== Object.keys(ADO_FIELD_MAP).length ||
        p.fields.some((f) => typeof f !== "object" || f === null || !Object.hasOwn(ADO_FIELD_MAP, f.field) || !hash(f.local) || !hash(f.remote) ||
            !(f.base === null || hash(f.base)) || typeof f.conflict !== "boolean") || new Set(p.fields.map((f) => f.field)).size !== p.fields.length) {
        throw new ResolutionRefusal("invalid_plan", "Generate a complete version 2 plan; do not edit its snapshot coordinates.");
    }
    const required = p.fields.filter((f) => f.local !== f.remote).map((f) => f.field);
    if (!Array.isArray(p.choices) || p.choices.length !== required.length || new Set(p.choices.map((c) => c?.field)).size !== p.choices.length ||
        p.choices.some((c) => typeof c !== "object" || c === null || !required.includes(c.field) || !["local", "remote"].includes(c.take))) {
        throw new ResolutionRefusal("invalid_choices", "Choose local or remote exactly once for every differing field; remove unknown, duplicate and redundant choices.");
    }
}
/** Build digests from the same field projections and three-way base used by sync. */
export function resolutionFields(item, remote, maps) {
    const local = localValues(item);
    const incoming = remoteValues(remote, maps.imports);
    const base = readBase(item, { ...incoming, relations: [] });
    if (base !== undefined && Object.hasOwn(base, "status") && Object.hasOwn(maps.exports, String(base.status)) && maps.exports[String(base.status)] === remote.fields["System.State"])
        incoming.status = base.status;
    return Object.keys(ADO_FIELD_MAP).map((field) => ({ field, base: base === undefined || !Object.hasOwn(base, field) ? null : resolutionDigest(base[field]),
        local: resolutionDigest(local[field]), remote: resolutionDigest(incoming[field]),
        conflict: threeWayFieldConflict(local[field], incoming[field], base?.[field]) }));
}
/** Revision-bound decisions use core reads, Plan storage and audited item mutation, never git. */
export class AdoResolutionService {
    pmRoot;
    author;
    pm;
    client;
    config;
    sdk;
    observer;
    /** Bind the tracker and REST client; omitted SDK preserves the legacy package-import default. */
    constructor(pmRoot, author, pm, client, config, sdk = loadResolutionSdk(), observer) {
        this.pmRoot = pmRoot;
        this.author = author;
        this.pm = pm;
        this.client = client;
        this.config = config;
        this.sdk = sdk;
        this.observer = observer;
    }
    /** Load authoritative item bytes with the same SDK normalization used by the mutation lock. */
    async document(id) {
        const settings = await this.sdk.readSettings(this.pmRoot);
        const located = await this.sdk.locateItem(this.pmRoot, id, settings.id_prefix, settings.item_format, this.sdk.resolveItemTypeRegistry(settings, this.sdk.getActiveExtensionRegistrations()).type_to_folder);
        if (located === null)
            throw new ResolutionRefusal("scope", "Select an existing linked pm item and generate a fresh plan.");
        const { document } = await this.sdk.readLocatedItem(located, { schema: settings.schema });
        return document;
    }
    /** Check identity and scope on every read, including when applying a portable artifact. */
    scope(item, remote) {
        if (item.ado_org_url !== this.config.orgUrl || item.ado_project !== this.config.project || item.ado_id !== remote.id ||
            !Number.isSafeInteger(remote.rev) || remote.rev < 1) {
            throw new ResolutionRefusal("scope", "Use the original organization, project and linked identities; import first if provenance is missing.");
        }
        const base = readBase(item, { ...localValues(item), relations: [] });
        if (remote.rev < Math.max(Number(item.ado_rev ?? 0), 0, ...Object.values(readBaseRevisions(base))))
            throw new ResolutionRefusal("stale_remote", "Azure returned an older revision than witnessed agreement; re-read the current work item.");
    }
    /** Require one hydrated REST work item rather than accepting an omitted batch row. */
    async remote(id) {
        const rows = await this.client.getWorkItems([id]);
        const remote = rows[0];
        if (rows.length !== 1 || remote.id !== id || typeof remote.fields !== "object" || remote.fields === null || Array.isArray(remote.fields)) {
            throw new ResolutionRefusal("stale_remote", "Azure omitted or changed the linked work item. Re-read its identity before planning.");
        }
        return remote;
    }
    /** Read normalized configured maps once per operation and bind their interpretation to the plan. */
    maps() {
        return { imports: stateMap(process.env.ADO_STATUS_MAP, IMPORT_STATE_MAP), exports: stateMap(process.env.ADO_EXPORT_STATE_MAP, STATE_MAP) };
    }
    /** Preview one linked item's scalar decisions with no tracker or REST writes. */
    async plan(id) {
        try {
            const { items } = await this.pm.listAllComplete();
            const document = await this.document(id);
            const item = document.metadata;
            if (items.filter((row) => row.ado_id === item.ado_id).length !== 1 || !Number.isSafeInteger(item.ado_id) || Number(item.ado_id) < 1) {
                throw new ResolutionRefusal("scope", "Import and establish one unique local link for this Azure work item before planning.");
            }
            const remote = await this.remote(Number(item.ado_id));
            this.scope(item, remote);
            const maps = this.maps();
            return { schema: "pm-ado/resolution/2", scope: { ref: resolutionScopeReference(this.config) },
                local: { id: item.id, revision: resolutionDigest(document) },
                remote: { id: remote.id, revision: remote.rev, digest: resolutionDigest(remote) },
                fields: resolutionFields(item, remote, maps), mapping: resolutionDigest(maps), choices: [] };
        }
        catch (error) {
            throw ResolutionRefusal.from(error);
        }
    }
    /** Fingerprint content independently of the prepare write's timestamp and recovery field. */
    guard(document) {
        const snapshot = structuredClone(document);
        delete snapshot.metadata.ado_resolution_intent;
        snapshot.metadata.updated_at = "";
        return resolutionDigest(snapshot);
    }
    /** Recognize durable settlement using the same immutable receipt used by normal replay. */
    async settled(item, decision) {
        return item.ado_resolution_receipt === decision ||
            (await this.sdk.readHistorySnapshot(this.sdk.getHistoryPath(this.pmRoot, item.id), item.id)).entries.some((entry) => entry.context?.ado_resolution === decision);
    }
    /** Name the exact recovery coordinate without disclosing configuration or field contents. */
    partial(decision, expected) {
        return new ResolutionRefusal("ado_partial_apply", `Intent ${decision} ${expected === null ? "has unreadable revision coordinates" : `expects Azure revision ${expected}`}. Restore tracker write access or lease ownership, then rerun ado resolve-apply with the SAME --plan or --artifact. If either side changed after prepare, preserve the intent and reconcile the recorded PATCH and item history manually; do not apply a new plan or repeat the PATCH blindly.`);
    }
    /** Rebuild the exact guarded wire document from reviewed values, including an ownership marker. */
    patch(plan, values, maps, decision) {
        const exports = plan.fields.filter((field) => resolutionDigest(values[field.field]) !== field.remote).map((field) => field.field).sort();
        return exports.length === 0 ? [] : buildUpdatePatch(plan.remote.revision, { ...azureFields(values, exports, maps.exports), "System.History": `pm-ado resolution ${decision}` }, [], "add");
    }
    /** Reject corrupted or substituted recovery data before using its stored PATCH. */
    intent(raw, plan, decision, maps) {
        let recoveryId = decision;
        let expected = null;
        try {
            const intent = JSON.parse(String(raw));
            if (typeof intent?.plan_id === "string" && /^[a-f0-9]{64}$/u.test(intent.plan_id))
                recoveryId = intent.plan_id;
            if (Number.isSafeInteger(intent?.expected_remote_revision) && intent.expected_remote_revision > 0)
                expected = intent.expected_remote_revision;
            if (intent === null || intent.plan_id !== decision || intent.local_revision !== plan.local.revision ||
                intent.remote_id !== plan.remote.id || intent.remote_revision !== plan.remote.revision ||
                intent.remote_digest !== plan.remote.digest || typeof intent.guard !== "string" ||
                typeof intent.values !== "object" || intent.values === null ||
                plan.fields.some((field) => resolutionDigest(intent.values[field.field]) !==
                    (plan.choices.find((choice) => choice.field === field.field)?.take === "local" ? field.local : field.remote)) ||
                resolutionDigest(intent.patch) !== resolutionDigest(this.patch(plan, intent.values, maps, decision)) ||
                intent.expected_remote_revision !== plan.remote.revision + (intent.patch.length === 0 ? 0 : 1)) {
                throw this.partial(recoveryId, expected);
            }
            return intent;
        }
        catch {
            throw this.partial(recoveryId, expected);
        }
    }
    /** Delegate lifecycle identity to the SDK without changing portable field or mapping digests. */
    nativeStatus(values, settings) {
        return this.sdk.normalizeStatusForRegistry(String(values.status), this.sdk.resolveRuntimeStatusRegistry(settings.schema));
    }
    /** Audit intent before the remote side effect; ordinary stale plans still make no item writes. */
    async prepare(plan, decision, maps, settings) {
        let prepared = null;
        await this.sdk.mutateItemWithHistoryContext({ pmRoot: this.pmRoot, settings, id: plan.local.id, author: this.author,
            op: "update", skipNoop: true, message: `Prepare Azure resolution ${decision}`, historyContext: { ado_resolution_prepare: decision },
            mutate: async (document) => {
                const item = document.metadata;
                if (await this.settled(item, decision))
                    return { changedFields: [] };
                if (item.ado_resolution_intent !== undefined) {
                    prepared = this.intent(item.ado_resolution_intent, plan, decision, maps);
                    return { changedFields: [] };
                }
                if (resolutionDigest(document) !== plan.local.revision)
                    throw new ResolutionRefusal("stale_local", "A local writer changed the item. Generate a new plan and review its choices.");
                const remote = await this.remote(plan.remote.id);
                this.scope(item, remote);
                if (remote.rev !== plan.remote.revision || resolutionDigest(remote) !== plan.remote.digest) {
                    throw new ResolutionRefusal("stale_remote", "An Azure writer changed the item. Generate a new plan and review its choices.");
                }
                if (resolutionDigest(resolutionFields(item, remote, maps).sort((a, b) => a.field.localeCompare(b.field))) !== resolutionDigest(plan.fields)) {
                    throw new ResolutionRefusal("invalid_plan", "Snapshot field digests were edited; generate a fresh plan.");
                }
                const local = localValues(item);
                const values = remoteValues(remote, maps.imports);
                const base = readBase(item, { ...values, relations: [] });
                if (base !== undefined && Object.hasOwn(base, "status") && Object.hasOwn(maps.exports, String(base.status)) && maps.exports[String(base.status)] === remote.fields["System.State"])
                    values.status = base.status;
                for (const choice of plan.choices)
                    if (choice.take === "local")
                        values[choice.field] = local[choice.field];
                const nativeStatus = this.nativeStatus(values, settings);
                await this.sdk.previewItemMutations({ pmRoot: this.pmRoot, transactionId: `ado-${decision}`, author: this.author,
                    mutations: [{ op: "update", id: item.id, options: { title: String(values.title), description: String(values.description),
                                ...(nativeStatus === item.status ? {} : { status: nativeStatus, closeReason: "Azure conflict resolution" }),
                                priority: Number(values.priority), tags: JSON.stringify(values.tags),
                                ...(values.assignee === "" ? { unset: ["assignee"] } : { assignee: String(values.assignee) }) } }] });
                const patch = this.patch(plan, values, maps, decision);
                prepared = { plan_id: decision, local_revision: plan.local.revision, guard: this.guard(document),
                    remote_id: remote.id, remote_revision: remote.rev, remote_digest: plan.remote.digest,
                    expected_remote_revision: remote.rev + (patch.length === 0 ? 0 : 1), patch, values, base: base ?? null };
                item.ado_resolution_intent = JSON.stringify(prepared);
                return { changedFields: ["ado_resolution_intent"] };
            } });
        return prepared;
    }
    /** Prove a prepared PATCH was applied, including its unique marker and complete mapped result. */
    applied(intent, remote, maps) {
        if (remote.rev !== intent.expected_remote_revision)
            return false;
        if (intent.patch.length === 0)
            return resolutionDigest(remote) === intent.remote_digest;
        const values = remoteValues(remote, maps.imports);
        if (maps.exports[String(intent.values.status)] === remote.fields["System.State"])
            values.status = intent.values.status;
        return String(remote.fields["System.History"]).includes(`pm-ado resolution ${intent.plan_id}`) && resolutionDigest(values) === resolutionDigest(intent.values);
    }
    /** Commit mapped values, lifecycle evidence and the settled receipt as one fenced SDK mutation. */
    async settle(plan, decision, intent, maps, settings) {
        let replayed = false;
        const settled = await this.sdk.mutateItemWithHistoryContext({ pmRoot: this.pmRoot, settings, id: plan.local.id, author: this.author,
            op: "update", skipNoop: true, message: `Settle Azure resolution ${decision}`, historyContext: { ado_resolution: decision },
            mutate: async (document) => {
                const item = document.metadata;
                if (await this.settled(item, decision)) {
                    replayed = true;
                    return { changedFields: [] };
                }
                const history = await this.sdk.readHistorySnapshot(this.sdk.getHistoryPath(this.pmRoot, item.id), item.id);
                if (item.ado_resolution_intent !== JSON.stringify(intent) || this.guard(document) !== intent.guard ||
                    history.entries.at(-1)?.context?.ado_resolution_prepare !== decision)
                    throw this.partial(decision, intent.expected_remote_revision);
                let remote = await this.remote(intent.remote_id);
                this.scope(item, remote);
                if (!this.applied(intent, remote, maps)) {
                    if (remote.rev !== intent.remote_revision || resolutionDigest(remote) !== intent.remote_digest)
                        throw this.partial(decision, intent.expected_remote_revision);
                    // The exact wire body is already durable in the item's prepare history.
                    await this.client.request("PATCH", `/_apis/wit/workitems/${intent.remote_id}?api-version=7.1&$expand=relations`, intent.patch, PATCH_MEDIA_TYPE);
                    remote = await this.remote(intent.remote_id);
                    if (!this.applied(intent, remote, maps))
                        throw this.partial(decision, intent.expected_remote_revision);
                }
                const previousStatus = item.status;
                const values = intent.values;
                for (const key of Object.keys(ADO_FIELD_MAP))
                    item[key] = values[key];
                item.status = this.nativeStatus(values, settings);
                if (values.assignee === "")
                    delete item.assignee;
                const statuses = this.sdk.resolveRuntimeStatusRegistry(settings.schema);
                const lifecycleFields = [];
                if (item.status !== previousStatus) {
                    if (item.status === statuses.close_status) {
                        item.closed_at = this.sdk.nowIso();
                        item.completed_at = item.closed_at;
                        item.close_reason = "Azure conflict resolution";
                        lifecycleFields.push("closed_at", "completed_at", "close_reason");
                    }
                    else if (!this.sdk.isTerminalStatus(item.status, statuses) && this.sdk.isTerminalStatus(previousStatus, statuses)) {
                        for (const key of ["closed_at", "completed_at", "close_reason", "resolution", "expected_result", "actual_result", "fixed_version"]) {
                            delete item[key];
                            lifecycleFields.push(key);
                        }
                    }
                }
                item.ado_resolution_receipt = decision;
                delete item.ado_resolution_intent;
                return { changedFields: [...lifecycleFields, ...Object.keys(ADO_FIELD_MAP), "ado_resolution_receipt", "ado_resolution_intent"] };
            } });
        return { replayed, version: settled.item.updated_at };
    }
    /** Prepare durably, then resume or settle under core item leases without replaying a successful PATCH. */
    async apply(input) {
        let recovery = null;
        try {
            validateResolutionPlan(input);
            const plan = structuredClone(input);
            plan.fields.sort((a, b) => a.field.localeCompare(b.field));
            plan.choices.sort((a, b) => a.field.localeCompare(b.field));
            const decision = resolutionDigest(plan);
            const maps = this.maps();
            if (plan.scope.ref !== resolutionScopeReference(this.config) || plan.mapping !== resolutionDigest(maps)) {
                throw new ResolutionRefusal("scope", "Restore the original local configuration and token, or regenerate the plan before any intent is prepared.");
            }
            const settings = await this.sdk.readSettings(this.pmRoot);
            const inspected = (await this.document(plan.local.id)).metadata;
            const pending = inspected.ado_resolution_intent;
            let expectedVersion = inspected.updated_at;
            if (pending !== undefined)
                recovery = this.intent(pending, plan, decision, maps);
            const intent = await this.prepare(plan, decision, maps, settings);
            recovery = intent;
            let replayed = true;
            if (intent !== null) {
                try {
                    await this.observer?.({ phase: "prepared", decision });
                    const result = await this.settle(plan, decision, intent, maps, settings);
                    replayed = result.replayed;
                    expectedVersion = result.version;
                }
                catch {
                    throw this.partial(decision, intent.expected_remote_revision);
                }
            }
            let readback;
            const agreement = await advanceSyncBase({ expectedVersion, minimumRemoteRevision: intent?.expected_remote_revision ?? plan.remote.revision,
                readLocal: async () => { readback = await readLocalAgreement(this.pm, plan.local.id, this.config, expectedVersion); return readback; },
                readRemote: async (local) => {
                    const remote = await this.remote(plan.remote.id);
                    this.scope(readback.item, remote);
                    return { revision: remote.rev, values: remoteAgreement(remote, local.values, this.config, readback.identities, maps.imports, maps.exports) };
                },
                publish: async (base, revision, version) => {
                    const field = [];
                    if (readback.item.ado_sync_base !== JSON.stringify(base))
                        field.push(`ado_sync_base=${JSON.stringify(base)}`);
                    if (revision !== undefined && readback.item.ado_rev !== revision)
                        field.push(`ado_rev=${revision}`);
                    const unset = revision !== undefined && readback.item.ado_sync_intent !== undefined ? ["ado_sync_intent"] : undefined;
                    if (field.length || unset !== undefined)
                        await this.sdk.commitItemMutations({ pmRoot: this.pmRoot, author: this.author,
                            transactionId: `ado-agreement-${this.sdk.deriveMutationTransactionId(JSON.stringify([plan.local.id, version, field]))}`,
                            mutations: [{ op: "update", id: plan.local.id, options: { field, unset, message: "Azure read-back agreement" }, match: { key: "updated_at", value: version } }] });
                } });
            if (agreement.differences.length)
                throw this.partial(decision, agreement.remote.revision);
            return { ok: true, decision, replayed, pm_id: plan.local.id };
        }
        catch (error) {
            if (recovery !== null && !(error instanceof ResolutionRefusal))
                throw this.partial(recovery.plan_id, recovery.expected_remote_revision);
            throw ResolutionRefusal.from(error);
        }
    }
}
/** CLI bridge with host-owned compact TOON/JSON rendering and core Plan persistence. */
export async function runResolutionCommand(ctx, mode) {
    try {
        const config = readConfig(process.env);
        if (config === undefined || ctx.sdk === undefined)
            throw new ResolutionRefusal("configuration", "Set ADO_ORG_URL, ADO_PROJECT and ADO_TOKEN; run with pm CLI 2026.10.23 or newer.");
        const client = ctx.sdk.client;
        /** Acquire low-level primitives only after the command selection is valid. */
        const service = () => new AdoResolutionService(ctx.pm_root, ctx.global.author ?? process.env.PM_AUTHOR ?? "unknown", client, new AdoClient(config, transport), config, loadResolutionSdk());
        if (mode === "plan") {
            if (typeof ctx.options.item !== "string")
                throw new ResolutionRefusal("configuration", "Supply --item with one linked pm item ID.");
            const plan = await service().plan(ctx.options.item);
            if (ctx.options.save === true) {
                const saved = await ctx.sdk.client.planCreate({ title: "Azure field conflict decisions", body: JSON.stringify(plan) });
                return { ok: true, plan_id: saved.plan.id, plan };
            }
            return { ok: true, plan };
        }
        if ((typeof ctx.options.plan === "string") === (typeof ctx.options.artifact === "string")) {
            throw new ResolutionRefusal("configuration", "Supply exactly one of --plan (core Plan ID) or --artifact (portable JSON file).");
        }
        const raw = typeof ctx.options.plan === "string" ? (await ctx.sdk.client.get(ctx.options.plan, { depth: "full" })).item.body
            : await readFile(String(ctx.options.artifact), "utf8");
        let plan;
        try {
            plan = JSON.parse(String(raw));
        }
        catch {
            throw new ResolutionRefusal("invalid_plan", "Use a core Plan body or JSON artifact produced by ado resolve-plan.");
        }
        return await service().apply(plan);
    }
    catch (error) {
        const refusal = ResolutionRefusal.from(error);
        return { ok: false, code: refusal.code, remedy: refusal.remedy, exit_code: refusal.exitCode };
    }
}
//# sourceMappingURL=resolution.js.map