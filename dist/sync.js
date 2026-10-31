import { randomUUID } from "node:crypto";
import { normalizeFieldValues, normalizeStatusValue, normalizeItemReference, normalizeScopeValue, normalizeStateMaps } from "./normalization.js";
/** Command orchestration and per-field Azure DevOps reconciliation. */
import { agreementMutation, advanceSyncBase, readBaseRevisions, knownBase, baseFields } from "./agreement.js";
import { loadResolutionSdk, resolutionDigest } from "./resolution.js";
import { SyncOutbox, isProtocolTag } from "./sync-outbox.js";
import { NativeWriteFence, NativeHistoryConflict } from "./history-fence.js";
import { AdoClient, CommandError, EXIT_CODE, RevisionConflict, RELATION_MAP, STATE_MAP, exportRelations, importRelations, planRelationImport, missingEnv, preflightMessage, readConfig, relationTargetId, } from "./index.js";
/** Default Azure state names mapped to local lifecycle states. */
export const IMPORT_STATE_MAP = {
    New: "open", Proposed: "open", "To Do": "open", Active: "in_progress",
    Committed: "in_progress", Doing: "in_progress", Blocked: "blocked",
    Resolved: "closed", Done: "closed", Closed: "closed", Removed: "closed",
};
/** Shared flags are typed by the host, which also owns JSON/TOON rendering. */
export const SYNC_FLAGS = [
    { long: "--dry-run", value_type: "boolean", description: "Read and plan without writing either tracker" },
    { long: "--limit", value_name: "n", value_type: "number", description: "Maximum items to process (default 100)", default: 100 },
    { long: "--wiql", value_name: "query", value_type: "string", description: "Explicit flat WIQL query for import/sync" },
    { long: "--area-path", value_name: "path", value_type: "string", description: "Import/sync: exact Azure area filter" },
    { long: "--iteration-path", value_name: "path", value_type: "string", description: "Import/sync: exact Azure iteration filter" },
    { long: "--type", value_name: "name", value_type: "string", description: "Azure work item type filter and creation type (default Task)" },
];
/** Compare canonical snapshots without depending on object property order. */
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
/** Detect a field requiring an explicit decision rather than choosing either writer. */
export function threeWayFieldConflict(local, remote, base) {
    return !equal(local, remote) && (base === undefined || !equal(local, base) && !equal(remote, base));
}
/** Read a string flag after the host has normalized kebab-case names. */
function option(options, name) {
    const value = options[name] ?? options[name.replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase())];
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || !value.trim())
        throw new CommandError(`--${name} requires a non-empty string`);
    return value;
}
/** Parse an optional JSON state map and reject unusable configuration before reads. */
export function stateMap(raw, defaults) {
    if (raw === undefined)
        return { ...defaults };
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new CommandError("State map must be valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
        Object.values(parsed).some((value) => typeof value !== "string" || !value.trim())) {
        throw new CommandError("State map must be a JSON object of non-empty strings");
    }
    return { ...defaults, ...parsed };
}
/** Escape WIQL literals; explicit WIQL cannot be combined with generated filters. */
export function buildWiql(options, project) {
    const explicit = option(options, "wiql");
    const filters = [["System.AreaPath", option(options, "area-path")],
        ["System.IterationPath", option(options, "iteration-path")], ["System.WorkItemType", option(options, "type")]];
    if (explicit !== undefined) {
        if (filters.some(([, value]) => value !== undefined))
            throw new CommandError("--wiql cannot be combined with filters");
        return explicit;
    }
    return `SELECT [System.Id] FROM WorkItems WHERE ${[["System.TeamProject", project], ...filters]
        .filter(([, value]) => value !== undefined).map(([name, value]) => `[${name}] = '${value.replaceAll("'", "''")}'`).join(" AND ")} ORDER BY [System.Id]`;
}
/** Canonicalize tags as a set for stable reconciliation and idempotency. */
function tags(value) { return [...new Set(value.map((tag) => tag.trim()).filter(Boolean))].sort(); }
/** Project Azure fields into the same normalized shape as local metadata. */
export function remoteValues(item, mapping, normalization) {
    const fields = item.fields;
    const state = String(fields["System.State"] ?? "New");
    if (!Object.hasOwn(mapping, state))
        throw new CommandError(`Unmapped Azure state: ${state}; configure ADO_STATUS_MAP`);
    const identity = fields["System.AssignedTo"];
    const assignee = typeof identity === "object" && identity !== null
        ? String(identity.uniqueName ?? identity.displayName ?? "")
        : String(identity ?? "");
    const priority = Number(fields["Microsoft.VSTS.Common.Priority"] ?? 2);
    if (!Number.isInteger(priority) || priority < 0 || priority > 4)
        throw new CommandError("Azure priority must be an integer from 0 to 4");
    const values = {
        title: String(fields["System.Title"] ?? ""), description: String(fields["System.Description"] ?? ""),
        status: mapping[state], priority, tags: tags(String(fields["System.Tags"] ?? "").split(";").map((tag) => tag.toLowerCase()).filter((tag) => !isProtocolTag(tag))), assignee,
        ado_area_path: String(fields["System.AreaPath"] ?? ""), ado_iteration_path: String(fields["System.IterationPath"] ?? ""),
    };
    return normalization === false ? values : normalizeFieldValues(values, normalization);
}
/** Project pm fields, preserving unrelated metadata outside this mapping. */
export function localValues(item, normalization) {
    const values = { title: item.title, description: item.description ?? "", status: item.status, priority: item.priority,
        tags: tags(item.tags.map((tag) => tag.toLowerCase())), assignee: item.assignee ?? "", ado_area_path: String(item.ado_area_path ?? ""),
        ado_iteration_path: String(item.ado_iteration_path ?? "") };
    return normalization === false ? values : normalizeFieldValues(values, normalization);
}
/** Decode and validate the dedicated base; missing legacy bases never imply a winner. */
export function readBase(item, sample, normalization) {
    if (item.ado_sync_base === undefined)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(String(item.ado_sync_base));
    }
    catch {
        throw new CommandError(`Invalid ado_sync_base for ${item.id}: expected valid JSON`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        throw new CommandError("Invalid ado_sync_base");
    const base = parsed, presentFields = new Set(baseFields(parsed));
    for (const [key, value] of Object.entries(sample)) {
        if ((base.ado_base_partial === 1 || Object.hasOwn(base, "ado_base_fields")) && !presentFields.has(key))
            continue;
        if (Array.isArray(value) ? !Array.isArray(base[key]) || base[key].some((entry) => typeof entry !== "string")
            : typeof base[key] !== typeof value)
            throw new CommandError(`Invalid ado_sync_base field: ${key}`);
    }
    const present = knownBase(base);
    return normalization === false ? present : normalizeFieldValues(present, normalization);
}
/** Exact field mapping used by reconciliation and remote-contract discovery. */
export const ADO_FIELD_MAP = {
    title: "System.Title", description: "System.Description", status: "System.State",
    priority: "Microsoft.VSTS.Common.Priority", tags: "System.Tags", assignee: "System.AssignedTo",
    ado_area_path: "System.AreaPath", ado_iteration_path: "System.IterationPath",
};
/** Convert agreed canonical values to Azure reference names for changed fields only. */
export function azureFields(values, keys, states, normalization) {
    if (normalization !== false) {
        values = normalizeFieldValues(values, normalization);
        states = normalizeStateMaps({ imports: {}, exports: states }, normalization).exports;
    }
    const names = ADO_FIELD_MAP;
    return Object.fromEntries(keys.filter((key) => key !== "relations").map((key) => {
        if (!Object.hasOwn(names, key))
            throw new CommandError(`Unknown mapped field: ${key}`);
        let value = values[key];
        if (key === "status") {
            if (!Object.hasOwn(states, String(value)))
                throw new CommandError(`Unmapped pm status: ${value}; configure ADO_EXPORT_STATE_MAP`);
            value = states[String(value)];
        }
        if (key === "tags")
            value = values.tags.join("; ");
        return [names[key], value];
    }));
}
/** Map an empty remote assignment to the SDK's explicit unset operation. */
function assignmentFields(value) {
    return value === "" ? { unset: ["assignee"] } : { assignee: value };
}
/** Convert canonical fields and provenance to one SDK mutation with a history record. */
export function pmFields(values, remote, config, normalization) {
    values = normalizeFieldValues(values, normalization);
    return { title: String(values.title), description: String(values.description), status: String(values.status),
        priority: Number(values.priority), tags: JSON.stringify(values.tags),
        ...assignmentFields(String(values.assignee)),
        field: [`ado_id=${remote.id}`, `ado_project=${config.project}`, `ado_org_url=${config.orgUrl}`,
            `ado_url=${config.orgUrl}/_apis/wit/workItems/${remote.id}`, `ado_type=${String(remote.fields["System.WorkItemType"] ?? "Task")}`,
            `ado_area_path=${values.ado_area_path}`, `ado_iteration_path=${values.ado_iteration_path}`],
        message: `Azure DevOps revision ${remote.rev}` };
}
/** Canonical recognized relations; opaque or out-of-scope links stay with the adapter. */
export function relationValues(relations, config, identities) {
    return tags(relations.flatMap((relation) => {
        const id = relationTargetId(relation.url, config.orgUrl);
        return Object.hasOwn(RELATION_MAP, relation.rel) && id !== undefined && identities.has(id) ? [JSON.stringify([relation.rel, id])] : [];
    }));
}
/** Compute desired remote relations from the adapter's add/remove plan. */
function applyRelations(remote, operations) {
    const result = [...remote.relations];
    for (const operation of operations) {
        if (operation.op === "remove")
            result.splice(Number(operation.path.split("/").at(-1)), 1);
        else
            result.push(operation.value);
    }
    return result;
}
/** Read actual local graph edges independently of a remote snapshot or proposed patch. */
export async function readLocalAgreement(pm, id, config, expectedVersion, normalization) {
    config = { ...config, orgUrl: normalizeScopeValue(config.orgUrl, true), project: normalizeScopeValue(config.project) };
    const snapshot = await pm.listAllComplete();
    const rawContext = normalization === undefined ? undefined : { resolveReference: (value) => normalization.sdk.normalizeRawItemId(value) };
    const raw = normalizeItemReference(id, rawContext);
    id = snapshot.items.some((row) => normalizeItemReference(row.id, rawContext) === raw) ? raw : normalizeItemReference(id, normalization);
    const item = snapshot.items.find((row) => normalizeItemReference(row.id, rawContext) === id);
    if (item === undefined)
        throw new CommandError("Local item disappeared before agreement", EXIT_CODE.conflict);
    if (expectedVersion !== undefined && item.updated_at !== expectedVersion)
        throw new CommandError("Local item changed before read-back agreement; re-read both trackers and retry", EXIT_CODE.conflict);
    const identities = new Map();
    for (const row of snapshot.items)
        if (normalizeScopeValue(String(row.ado_project ?? "")) === normalizeScopeValue(config.project) && (row.ado_org_url === undefined || normalizeScopeValue(String(row.ado_org_url), true) === normalizeScopeValue(config.orgUrl, true)) && Number.isSafeInteger(row.ado_id))
            identities.set(Number(row.ado_id), row.id);
    const empty = { id: Number(item.ado_id), rev: 0, fields: {}, relations: [] };
    const graph = await exportRelations(empty, config.orgUrl, identities, { listAllComplete: async () => snapshot });
    const values = { ...localValues(item, normalization), relations: relationValues(applyRelations(empty, graph.operations), config, identities) };
    return { item, identities, values, version: item.updated_at, base: readBase(item, values, normalization), acknowledgedRevision: typeof item.ado_rev === "number" ? item.ado_rev : undefined };
}
/** Project mapped scalars through SDK normalization, retaining only an explicit equivalent export witness. */
export function remoteScalarValues(remote, preferred, imports, exports, normalization) {
    const values = remoteValues(remote, imports, normalization);
    const output = normalization === false ? exports : normalizeStateMaps({ imports, exports }, normalization).exports;
    const status = preferred?.status;
    if (typeof status === "string") {
        const canonical = normalization === false ? status : normalizeStatusValue(status, normalization);
        if (Object.hasOwn(output, canonical) && output[canonical] === remote.fields["System.State"])
            values.status = canonical;
    }
    return values;
}
/** Compare actual expanded Azure and local reads in the same native field representation. */
export function remoteAgreement(remote, local, config, identities, imports, exports, normalization) {
    return { ...remoteScalarValues(remote, local, imports, exports, normalization), relations: relationValues(remote.relations ?? [], config, identities) };
}
/** Compare a proven owned effect without claiming its unrelated remote fields were ever agreed. */
export function recoveredField(local, remote, original, accepted) {
    if (equal(remote, accepted))
        return equal(local, original) ? "remote" : "local";
    return equal(local, original) ? "remote" : "conflict";
}
/** Select only the latest request that actually touched a key and has not been superseded by agreement. */
function fieldEffect(key, witnessed, effects) {
    return [...effects].reverse().find((candidate) => candidate.keys.includes(key) && (key !== "relations" || candidate.relations === true) && (witnessed[key] ?? 0) <= candidate.revision);
}
/** Choose each key from its witnessed base or the latest proof for that exact owned field. */
export function mergeSyncValues(local, remote, base, effect, normalization) {
    local = normalizeFieldValues(local, normalization);
    remote = normalizeFieldValues(remote, normalization);
    if (base !== undefined)
        base = normalizeFieldValues(knownBase(base), normalization);
    const witnessed = readBaseRevisions(base);
    const effects = (effect === undefined ? [] : Array.isArray(effect) ? effect : [effect]).map((candidate) => ({ ...candidate,
        original: normalizeFieldValues(candidate.original, normalization), accepted: normalizeFieldValues(candidate.accepted, normalization) }));
    return Object.fromEntries(Object.keys(remote).map((key) => {
        const owned = fieldEffect(key, witnessed, effects);
        return [key, equal(local[key], remote[key]) ? "equal" :
                owned !== undefined ? key === "relations" ? equal(local[key], owned.accepted[key]) ? "remote" : "conflict"
                    : recoveredField(local[key], remote[key], owned.original[key], owned.accepted[key]) :
                    threeWayFieldConflict(local[key], remote[key], base?.[key]) ? "conflict" :
                        !equal(remote[key], base?.[key]) ? "remote" : "local"];
    }));
}
/** Describe a refused revision using the client's single diagnostic snapshot. */
function revisionConflict(entry, error, config, identities, states) {
    const current = error.current;
    const remote = current === undefined ? {} : remoteValues(current, states);
    remote.relations = current === undefined ? [] : relationValues(current.relations ?? [], config, identities);
    const local = { ...localValues(entry.local), relations: entry.values.relations };
    return { pm_id: entry.local.id, ado_id: entry.remote.id, stored_rev: error.assertedRev, remote_rev: current?.rev ?? null,
        fields: Object.fromEntries(Object.keys(local).filter((key) => !equal(local[key], remote[key]))
            .map((key) => [key, { local: local[key], remote: remote[key] ?? null }])) };
}
/** Execute the real REST transport; failures are converted to stable command receipts. */
export async function transport(method, url, body, headers) {
    const response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(30_000) });
    return { status: response.status, body: await response.text() };
}
/** Build and apply one command plan using only the host-bound SDK client. */
export async function runSyncCommand(ctx, mode, observer, sdkAnchors) {
    const plans = [];
    const conflicts = [];
    const diagnostics = [];
    let nativeWrites;
    let activeItem;
    const dryRun = ctx.options.dryRun === true || ctx.options["dry-run"] === true;
    /** Render native and Azure plan refusals with the same forward-only field contract. */
    const conflictResult = () => ({ ok: false, code: "ADO_CONFLICT", kind: "sync_conflict",
        error: "Local sync persistence refused; conflicting current fields require a fresh plan.", exit_code: EXIT_CODE.conflict,
        dry_run: dryRun, plans, conflicts, diagnostics,
        sync_conflict: { code: "sync_conflict", pm_id: conflicts[0].pm_id,
            fields: Object.fromEntries(Object.entries(conflicts[0].fields).map(([key, value]) => [key, { base: value.base ?? null, current: value.local }])) } });
    try {
        const config = readConfig(process.env);
        if (config === undefined)
            throw new CommandError(preflightMessage(ctx.command, missingEnv(process.env)));
        const pm = ctx.sdk?.client;
        if (pm === undefined)
            throw new CommandError("This command requires a host-bound SDK (pm CLI 2026.10.12 or newer)");
        const limit = Number(ctx.options.limit ?? 100);
        if (!Number.isSafeInteger(limit) || limit < 1)
            throw new CommandError("--limit must be a positive safe integer");
        const requestedStates = stateMap(process.env.ADO_STATUS_MAP, IMPORT_STATE_MAP);
        const exportStates = stateMap(process.env.ADO_EXPORT_STATE_MAP, STATE_MAP);
        if (mode === "export" && ["wiql", "area-path", "iteration-path"].some((name) => option(ctx.options, name) !== undefined)) {
            throw new CommandError("WIQL, area and iteration filters apply to import/sync only");
        }
        const wiql = buildWiql(ctx.options, config.project);
        const client = new AdoClient(config, async (method, url, body, headers) => {
            const operation = `${method} ${new URL(url).pathname}`;
            // Create dispatch has its own observer, after the intent is durable.
            const create = method === "POST" && url.includes("/workitems/$");
            if (!create)
                await observer?.({ boundary: "remote", phase: "before", operation });
            try {
                return await transport(method, url, body, headers);
            }
            finally {
                if (!create)
                    await observer?.({ boundary: "remote", phase: "after", operation });
            }
        });
        let sdk;
        try {
            sdk = loadResolutionSdk(sdkAnchors);
        }
        catch {
            throw new CommandError("Install pm-ado with pm install so the host links its SDK; guarded sync requires the SDK module");
        }
        const settings = await sdk.readSettings(ctx.pm_root);
        const statusRegistry = sdk.resolveRuntimeStatusRegistry(settings.schema);
        const normalization = { sdk, schema: settings.schema, idPrefix: settings.id_prefix };
        const states = Object.fromEntries(Object.entries(requestedStates).map(([remote, status]) => [remote, normalizeStatusValue(status, normalization)]));
        const author = sdk.selectImportAuthor(ctx.global.author, settings.author_default);
        const outbox = new SyncOutbox(ctx.pm_root, author, config, client, observer, sdk);
        let snapshot = await pm.listAllComplete();
        const writes = new NativeWriteFence(sdk, ctx.pm_root, author);
        nativeWrites = writes;
        if (!dryRun) {
            for (const item of snapshot.items)
                await writes.capture(item.id);
            snapshot = await pm.listAllComplete();
        }
        let { items } = snapshot;
        const versions = new Map(items.map((item) => [item.id, item.updated_at]));
        const localPlans = new Map();
        const foreignKeys = new Map();
        const ownedKeys = new Map();
        const initialKeys = new Map();
        const initialImportTargets = new Set();
        const localRemote = new Map(items.flatMap((item) => Number.isSafeInteger(item.ado_id) && Number.isSafeInteger(item.ado_rev) && Number(item.ado_rev) > 0
            ? [[item.id, { id: Number(item.ado_id), revision: Number(item.ado_rev) }]] : []));
        const scope = resolutionDigest([config.orgUrl, config.project]);
        const observed = new Map();
        // Remember peer edits after unacknowledged integration effects even when obsolete intents are discarded.
        for (const item of items) {
            const history = (await sdk.readHistorySnapshot(sdk.getHistoryPath(ctx.pm_root, item.id), item.id)).entries;
            const latest = new Map(), agreed = new Map();
            // Explicit import may adopt untouched birth fields or unchanged native agreements, never a later edit or ABA.
            const initial = new Set(), current = localValues(item, normalization);
            if (history[0]?.op === "create") {
                const birth = sdk.replayToItemDocument(sdk.replayHistoryToTarget(history, 0)).metadata;
                const born = localValues(birth, normalization);
                for (const key of Object.keys(ADO_FIELD_MAP))
                    if (equal(born[key], current[key]))
                        initial.add(key);
                if (sdk.stableValueEquals(birth.parent, item.parent) && sdk.stableValueEquals(birth.dependencies, item.dependencies))
                    initial.add("relations");
            }
            for (const [index, entry] of history.entries()) {
                const own = entry.message?.startsWith("bulk-item-transaction ado-sync-") === true || entry.message?.startsWith("bulk-item-transaction ado-local-") === true ||
                    entry.op === "create" && entry.message?.startsWith("Azure DevOps revision ") === true;
                if (own && entry.op === "create")
                    for (const key of [...Object.keys(ADO_FIELD_MAP), "relations"])
                        latest.set(key, false);
                const revision = own ? entry.message?.match(/(?:^|; )Azure DevOps revision (\d+)$/u) : undefined;
                if (revision !== undefined && revision !== null && Number.isSafeInteger(Number(revision[1])))
                    observed.set(item.id, Math.max(observed.get(item.id) ?? 0, Number(revision[1])));
                const patches = sdk.normalizeReplayPatchOps(entry.patch);
                if (patches.some((patch) => patch.path === "/metadata")) {
                    const before = index === 0 ? sdk.emptyImportedDocument() : sdk.replayToItemDocument(sdk.replayHistoryToTarget(history, index - 1));
                    const after = sdk.replayToItemDocument(sdk.replayHistoryToTarget(history, index));
                    for (const key of [...Object.keys(ADO_FIELD_MAP), "parent", "dependencies", "ado_sync_base", "ado_sync_intent"]) {
                        if (!sdk.stableValueEquals(before.metadata[key], after.metadata[key]))
                            patches.push(after.metadata[key] === undefined
                                ? { op: "remove", path: `/metadata/${key}` } : { op: "add", path: `/metadata/${key}`, value: after.metadata[key] });
                    }
                }
                for (const patch of patches) {
                    if (own && patch.path === "/metadata/ado_sync_intent" && "value" in patch) {
                        try {
                            const checkpoint = JSON.parse(String(patch.value));
                            if (Number.isSafeInteger(checkpoint.remote?.id) && checkpoint.remote?.id === Number(item.ado_id) && Number.isSafeInteger(checkpoint.remote?.revision)) {
                                observed.set(item.id, Math.max(observed.get(item.id) ?? 0, checkpoint.remote.revision));
                            }
                        }
                        catch { /* Mutable/corrupt old intents never become a refusal; only native own observations count. */ }
                    }
                    if (patch.path === "/metadata/ado_sync_base" && "value" in patch) {
                        try {
                            const base = knownBase(JSON.parse(String(patch.value))), revisions = readBaseRevisions(base);
                            const canonical = normalizeFieldValues(base, normalization);
                            for (const key of baseFields(base)) {
                                initial.delete(key);
                                // The mutable cache can be narrowed later; native scalar agreement remains a witness until the next field edit.
                                if (own && Object.hasOwn(ADO_FIELD_MAP, key) && equal(canonical[key], current[key]))
                                    initial.add(key);
                                const coordinate = JSON.stringify([base[key], revisions[key]]);
                                if (agreed.get(key) !== coordinate) {
                                    latest.delete(key);
                                    agreed.set(key, coordinate);
                                }
                            }
                        }
                        catch { /* Old malformed base metadata cannot authorize a write or prevent replanning. */ }
                    }
                    const field = patch.path.split("/")[2], key = ["parent", "dependencies"].includes(field) ? "relations" : field;
                    if (entry !== history[0])
                        initial.delete(key);
                    if ((Object.hasOwn(ADO_FIELD_MAP, key) || key === "relations") && (own || latest.has(key)))
                        latest.set(key, !own);
                }
            }
            foreignKeys.set(item.id, new Set([...latest].filter(([, foreign]) => foreign).map(([key]) => key)));
            ownedKeys.set(item.id, new Set([...latest].filter(([, foreign]) => !foreign).map(([key]) => key)));
            initialKeys.set(item.id, initial);
        }
        const identities = new Map();
        for (const item of items) {
            if (item.ado_id === undefined)
                continue;
            if (item.ado_org_url !== undefined && normalizeScopeValue(String(item.ado_org_url), true) !== normalizeScopeValue(config.orgUrl, true) ||
                normalizeScopeValue(String(item.ado_project ?? "")) !== normalizeScopeValue(config.project))
                throw new CommandError(`Azure scope mismatch for ${item.id}`);
            const id = Number(item.ado_id);
            if (!Number.isSafeInteger(id) || id < 1 || identities.has(id))
                throw new CommandError("ado_id must be unique positive safe integers");
            identities.set(id, item.id);
        }
        /** Write one SDK mutation, carrying only this command's immutable history revision. */
        const commitLocal = async (id, options, operation, transactionId) => {
            activeItem = id;
            await observer?.({ boundary: "local", phase: "before", operation, item: id });
            try {
                versions.set(id, await writes.update(id, options, transactionId));
            }
            catch (error) {
                if (error instanceof sdk.PmCliError && error.exitCode === EXIT_CODE.conflict)
                    throw new CommandError("Local sync persistence refused; re-read both trackers and retry. Earlier Azure or pm operations may have succeeded.", EXIT_CODE.conflict);
                throw error;
            }
            await observer?.({ boundary: "local", phase: "after", operation, item: id });
            await writes.assertCurrent(id);
        };
        /** Record observed revisions before effects, then write forward; checkpoints are retired on restart. */
        const persist = async (id, options, operation = "update") => {
            let pending = localPlans.get(id);
            if (pending === undefined && operation !== "agreement") {
                pending = { schema: "pm-ado/local/2", scope, plan: randomUUID(), remote: localRemote.get(id) };
                await commitLocal(id, { field: [`ado_sync_intent=${JSON.stringify(pending)}`] }, "local-prepared", `ado-local-${pending.plan}`);
                localPlans.set(id, pending);
            }
            if (operation !== "agreement" && pending !== undefined && !equal(pending.remote, localRemote.get(id))) {
                pending.remote = localRemote.get(id);
                await commitLocal(id, { field: [`ado_sync_intent=${JSON.stringify(pending)}`] }, "local-replanned", `ado-sync-${pending.plan}-${randomUUID()}`);
            }
            await commitLocal(id, options, operation, `ado-sync-${pending?.plan ?? "agreement"}-${randomUUID()}`);
        };
        /** Recovery ownership applies to every actual graph endpoint, independent of query selection. */
        const guardRelationUpdate = async (id, options) => {
            const relationWrite = options.parent !== undefined || options.dep !== undefined ||
                options.unset?.some((key) => key === "parent" || key === "dependencies");
            if (!relationWrite)
                return;
            activeItem = id;
            const foreign = foreignKeys.get(id)?.has("relations") === true;
            if (!foreign && (ownedKeys.get(id)?.has("relations") || initialImportTargets.has(id) && initialKeys.get(id)?.has("relations") || !items.some((item) => item.id === id)))
                return;
            const local = await readLocalAgreement(pm, id, config, undefined, normalization);
            if (foreign || !equal(local.values.relations, local.base?.relations))
                throw new NativeHistoryConflict(id, { relations: { base: local.base?.relations ?? null, current: local.values.relations } });
        };
        /** Finish native close policy forward; a restart derives remaining work from fresh reads and native history. */
        const update = async (id, options) => {
            await guardRelationUpdate(id, options);
            if (options.status !== statusRegistry.close_status)
                return persist(id, options);
            const { status, closeReason, completedAt, ...scalars } = options;
            await persist(id, scalars);
            const pending = localPlans.get(id);
            pending.stage = "close";
            await persist(id, { field: [`ado_sync_intent=${JSON.stringify(pending)}`] }, "close-prepared");
            await persist(id, { status, closeReason: closeReason, completedAt, force: options.force, message: options.message }, "close");
            if (scalars.assignee !== undefined && scalars.assignee !== "")
                await persist(id, { assignee: scalars.assignee, message: options.message }, "assignment");
        };
        /** Retire advisory metadata after input validation; never replay values or require a mutable intent proof. */
        const retireIntents = async () => {
            if (!dryRun)
                for (const item of items.filter((item) => item.ado_sync_intent !== undefined)) {
                    await commitLocal(item.id, { unset: ["ado_sync_intent"], message: "Discard obsolete Azure sync intent; replan current state" }, "intent-discarded", `ado-discard-${randomUUID()}`);
                }
        };
        const snapshotReader = { listAllComplete: async () => snapshot };
        const selected = mode === "export" ? items.slice(0, limit) : [];
        const ids = mode === "export" ? selected.flatMap((item) => item.ado_id === undefined ? [] : [Number(item.ado_id)])
            : [...new Set(await client.queryIds(wiql, limit))].slice(0, limit);
        if (ids.some((id) => !Number.isSafeInteger(id) || id < 1))
            throw new CommandError("WIQL returned an invalid work item identity", EXIT_CODE.remote);
        const report = await client.getWorkItemsReport(ids);
        if (report.missing.length)
            throw new CommandError(`Missing work items: ${report.missing.join(", ")}`, EXIT_CODE.remote);
        for (const remote of report.items) {
            if (!ids.includes(remote.id) || !Number.isSafeInteger(remote.rev) || remote.rev < 1 ||
                typeof remote.fields !== "object" || remote.fields === null)
                throw new CommandError("Invalid work item response", EXIT_CODE.remote);
        }
        const remotes = new Map(report.items.map((item) => [item.id, { ...item, relations: item.relations ?? [] }]));
        const recovered = await outbox.owners([...remotes.values()], items);
        const effects = new Map();
        for (const [remote, owner] of recovered) {
            if (identities.has(remote) && identities.get(remote) !== owner.item)
                throw new CommandError("Azure recovery identity is already linked to another pm item", EXIT_CODE.conflict);
            identities.set(remote, owner.item);
            if (owner.creation.base !== null)
                effects.set(owner.item, [{ original: owner.creation.base,
                        accepted: { ...remoteValues(owner.creation.accepted, states, normalization), relations: [] }, keys: Object.keys(ADO_FIELD_MAP), revision: 0 }]);
        }
        for (const [item, recoveries] of await outbox.recoverEffects([...remotes.values()], items)) {
            effects.set(item, [...(effects.get(item) ?? []), ...recoveries.map((recovery) => ({ original: recovery.original,
                    accepted: { ...remoteValues(recovery.accepted, states, normalization), relations: relationValues(recovery.accepted.relations ?? [], config, identities) },
                    keys: [...Object.keys(ADO_FIELD_MAP).filter((key) => Object.hasOwn(recovery.fields, ADO_FIELD_MAP[key])), ...(recovery.relations.length ? ["relations"] : [])], relations: recovery.relations.length ? true : undefined, revision: recovery.revision }))]);
        }
        const pairs = mode === "export" ? selected.map((local) => ({ local, remote: remotes.get(Number(local.ado_id)) }))
            : [...remotes.values()].map((remote) => ({ remote, local: items.find((item) => item.id === identities.get(remote.id)) }));
        const paired = new Set(pairs.map((pair) => pair.local?.id));
        if (mode === "sync")
            for (const local of items.filter((item) => item.ado_id === undefined && !paired.has(item.id)).slice(0, limit - pairs.length))
                pairs.push({ local, remote: undefined });
        if (mode === "import")
            for (const pair of pairs)
                if (pair.local !== undefined)
                    initialImportTargets.add(pair.local.id);
        const entries = [];
        for (const { local, remote } of pairs) {
            if (local !== undefined && remote !== undefined && Number.isSafeInteger(local.ado_rev) && Number(local.ado_rev) > remote.rev) {
                throw new CommandError("Azure returned an older revision; re-read the current work item before importing or exporting", EXIT_CODE.conflict);
            }
            const plan = { pm_id: local?.id ?? null, ado_id: remote?.id ?? null, action: "none", import_fields: [], export_fields: [] };
            plans.push(plan);
            const remoteFields = remote === undefined ? undefined : remoteValues(remote, states, normalization);
            const localFields = local === undefined ? undefined : localValues(local, normalization);
            const values = { ...(remoteFields ?? localFields) };
            const entry = { plan, local, remote, values, pullRelations: false, operations: [] };
            entries.push(entry);
            if (remote === undefined) {
                plan.action = "create_remote";
                plan.export_fields = Object.keys(values);
                azureFields(values, plan.export_fields, exportStates, normalization);
                continue;
            }
            if (local === undefined) {
                plan.action = "create_local";
                plan.import_fields = Object.keys(values);
                entry.pullRelations = true;
                continue;
            }
            const relationPlan = await exportRelations(remote, config.orgUrl, identities, snapshotReader);
            diagnostics.push(...relationPlan.unmapped, ...relationPlan.unmappedLocal);
            const r = { ...remoteFields, relations: relationValues(remote.relations, config, identities) };
            const empty = { ...remote, relations: [] };
            const localGraph = await exportRelations(empty, config.orgUrl, identities, snapshotReader);
            const l = { ...localFields, relations: relationValues(applyRelations(empty, localGraph.operations), config, identities) };
            const storedBase = readBase(local, r, normalization);
            const minimum = Math.max(0, ...Object.values(readBaseRevisions(storedBase)), observed.get(local.id) ?? 0);
            if (remote.rev < minimum)
                throw new CommandError("Azure returned an older revision than durable local recovery; re-read both trackers", EXIT_CODE.conflict);
            const base = storedBase;
            const effect = effects.get(local.id);
            const relationEffect = fieldEffect("relations", readBaseRevisions(base), effect ?? []);
            // A proven PATCH authorizes only the graph it actually accepted, never a later local edit.
            if (relationEffect !== undefined && equal(l.relations, relationEffect.accepted.relations))
                ownedKeys.get(local.id).add("relations");
            // Preserve a locally distinct status whose configured Azure representation
            // is unchanged (the default blocked and in_progress both export Active).
            if (mode !== "import")
                r.status = remoteScalarValues(remote, base, states, exportStates, normalization).status;
            const decisions = mergeSyncValues(l, r, base, effect, normalization);
            const differing = {};
            for (const key of Object.keys(r)) {
                if (mode === "import") {
                    if (!equal(l[key], r[key]) && (foreignKeys.get(local.id)?.has(key) || !ownedKeys.get(local.id)?.has(key) && !initialKeys.get(local.id)?.has(key) && decisions[key] !== "remote")) {
                        differing[key] = { base: storedBase?.[key], local: l[key], remote: r[key] };
                    }
                    else {
                        values[key] = r[key];
                        if (!equal(l[key], r[key]))
                            plan.import_fields.push(key);
                    }
                }
                else if (mode === "export") {
                    if (!equal(l[key], r[key]) && ownedKeys.get(local.id)?.has(key)) {
                        values[key] = r[key];
                        plan.import_fields.push(key);
                    }
                    else {
                        values[key] = l[key];
                        if (!equal(l[key], r[key]))
                            plan.export_fields.push(key);
                    }
                }
                else if (!equal(l[key], r[key]) && foreignKeys.get(local.id)?.has(key))
                    differing[key] = { base: base?.[key], local: l[key], remote: r[key] };
                else if (!equal(l[key], r[key]) && ownedKeys.get(local.id)?.has(key)) {
                    values[key] = r[key];
                    plan.import_fields.push(key);
                }
                else if (decisions[key] === "equal")
                    values[key] = r[key];
                else if (decisions[key] === "conflict")
                    differing[key] = { base: base?.[key], local: l[key], remote: r[key] };
                else if (decisions[key] === "remote") {
                    values[key] = r[key];
                    plan.import_fields.push(key);
                }
                else {
                    values[key] = l[key];
                    plan.export_fields.push(key);
                }
            }
            // The additive import adapter cannot safely erase local graph structure.
            // Refuse remote removals instead of silently resurrecting deleted links.
            if (mode === "sync" && plan.import_fields.includes("relations") &&
                l.relations.some((value) => !r.relations.includes(value))) {
                differing.relations = { base: base?.relations, local: l.relations, remote: r.relations };
            }
            if (Object.keys(differing).length)
                conflicts.push({ pm_id: local.id, ado_id: remote.id,
                    stored_rev: local.ado_rev, remote_rev: remote.rev, fields: differing });
            entry.pullRelations = mode === "import" || plan.import_fields.includes("relations");
            entry.operations = plan.export_fields.includes("relations") ? relationPlan.operations : [];
            plan.action = plan.import_fields.length || plan.export_fields.length ? "reconcile" : "none";
            if (plan.export_fields.length) {
                const asserted = mode === "sync" || effects.has(local.id) ? remote.rev : local.ado_rev;
                if (!Number.isSafeInteger(asserted) || Number(asserted) < 1)
                    throw new CommandError(`Missing valid ado_rev for ${local.id}; import first`);
                entry.revision = Number(asserted);
                if (mode === "export" && entry.revision !== remote.rev) {
                    conflicts.push(revisionConflict(entry, new RevisionConflict(remote.id, entry.revision, remote), config, identities, states));
                }
            }
            // Validate export mappings even in dry-run, before any write on either side.
            azureFields(values, plan.export_fields, exportStates, normalization);
        }
        // Reject edits made during planning before creating neighboring items or retiring any intent.
        if (!dryRun)
            for (const entry of entries)
                if (entry.local !== undefined)
                    await writes.assertCurrent(entry.local.id);
        if (conflicts.length)
            return conflictResult();
        const pulled = entries.filter((entry) => entry.pullRelations && entry.remote !== undefined && (mode === "sync" || entry.local !== undefined)).map((entry) => entry.remote);
        if (pulled.length) {
            const footprint = await planRelationImport(pulled, config.orgUrl, identities, snapshotReader, {}, true);
            for (const { id, options } of footprint.updates)
                await guardRelationUpdate(id, options);
        }
        await retireIntents(); // Scalar and relation validation precedes every housekeeping write.
        if (!dryRun) {
            for (const entry of entries)
                if (entry.local !== undefined) {
                    if (entry.remote !== undefined) {
                        localRemote.set(entry.local.id, { id: entry.remote.id, revision: entry.remote.rev });
                    }
                }
            for (const entry of entries) {
                const { plan, local, values } = entry;
                let remote = entry.remote;
                try {
                    if (remote === undefined) {
                        const fields = azureFields(values, plan.export_fields, exportStates, normalization);
                        for (const name of ["System.AreaPath", "System.IterationPath"])
                            if (fields[name] === "")
                                delete fields[name];
                        // Creation has no prior revision; the server allocates identity and rev 1.
                        const created = await outbox.create(local.id, option(ctx.options, "type") ?? process.env.ADO_WORK_ITEM_TYPE ?? "Task", fields, localValues(local, normalization));
                        remote = created.remote;
                        localRemote.set(local.id, { id: remote.id, revision: remote.rev });
                        // Creation is not idempotent: retain its identity before any later work can fail.
                        plan.ado_id = remote.id;
                        const field = [`ado_id=${remote.id}`, `ado_project=${config.project}`,
                            `ado_org_url=${config.orgUrl}`, `ado_url=${config.orgUrl}/_apis/wit/workItems/${remote.id}`];
                        await update(local.id, { field, message: `Linked to Azure DevOps work item ${remote.id}` });
                        plan.linked_fields = field.map((value) => value.slice(0, value.indexOf("=")));
                        if (created.recovered) {
                            // A retry links the existing object before reconciling the newly inspected local edit.
                            const accepted = remoteValues(created.accepted, states, normalization);
                            const current = remoteValues(remote, states, normalization);
                            for (const key of Object.keys(values)) {
                                if (created.base !== null && equal(values[key], created.base[key]))
                                    values[key] = accepted[key];
                                if (threeWayFieldConflict(values[key], current[key], accepted[key]))
                                    throw new CommandError("Azure creation recovery needs an explicit field decision", EXIT_CODE.conflict);
                                if (equal(values[key], accepted[key]))
                                    values[key] = current[key];
                            }
                            const changed = Object.keys(values).filter((key) => !equal(values[key], current[key]));
                            if (changed.length)
                                remote = await outbox.patch(local.id, remote, azureFields(values, changed, exportStates, normalization), [], localValues(local, normalization));
                        }
                        else
                            Object.assign(values, remoteValues(remote, states, normalization));
                        identities.set(remote.id, local.id);
                    }
                    else if (plan.export_fields.length) {
                        remote = await outbox.patch(local.id, { ...remote, rev: entry.revision }, azureFields(values, plan.export_fields, exportStates, normalization), entry.operations, localValues(local, normalization));
                    }
                }
                catch (error) {
                    if (!(error instanceof RevisionConflict))
                        throw error;
                    conflicts.push(revisionConflict(entry, error, config, identities, states));
                    continue;
                }
                entry.remote = { ...remote, relations: remote.relations ?? [] };
                if (local !== undefined) {
                    localRemote.set(local.id, { id: remote.id, revision: remote.rev });
                }
                // Persist the base only after relation import succeeds below.
                if (local === undefined) {
                    const initial = pmFields(values, remote, config, normalization);
                    await observer?.({ boundary: "local", phase: "before", operation: "create" });
                    const { item } = await pm.create({ ...initial, type: "Task", unset: undefined,
                        field: initial.field });
                    await observer?.({ boundary: "local", phase: "after", operation: "create", item: item.id });
                    entry.local = item;
                    localRemote.set(item.id, { id: remote.id, revision: remote.rev });
                    versions.set(item.id, item.updated_at);
                    await writes.captureCreated(item);
                    plan.pm_id = item.id;
                    identities.set(remote.id, item.id);
                }
                plan.ado_id = remote.id;
            }
            // A 412 leaves its local item and history untouched, including inverse links.
            if (conflicts.length)
                return conflictResult();
            for (const entry of entries.filter((candidate) => candidate.plan.action === "create_remote")) {
                const relationPlan = await exportRelations(entry.remote, config.orgUrl, identities, pm);
                diagnostics.push(...relationPlan.unmapped, ...relationPlan.unmappedLocal);
                entry.values.relations = relationValues(applyRelations(entry.remote, relationPlan.operations), config, identities);
                if (relationPlan.operations.length) {
                    try {
                        entry.remote = await outbox.patch(entry.local.id, entry.remote, {}, relationPlan.operations, localValues(entry.local, normalization));
                    }
                    catch (error) {
                        if (!(error instanceof RevisionConflict))
                            throw error;
                        conflicts.push(revisionConflict(entry, error, config, identities, states));
                    }
                }
            }
            if (conflicts.length)
                return conflictResult();
            const pulled = entries.filter((entry) => entry.pullRelations).map((entry) => entry.remote);
            if (pulled.length)
                diagnostics.push(...(await importRelations(pulled, config.orgUrl, identities, { listAllComplete: () => pm.listAllComplete(), update })).unmapped);
            for (const entry of entries) {
                const { values, remote, local } = entry;
                activeItem = local.id;
                values.relations = relationValues(remote.relations, config, identities);
                const fields = pmFields(values, remote, config, normalization);
                if (normalizeStatusValue(String(values.status), normalization) === normalizeStatusValue(local.status, normalization))
                    delete fields.status;
                if (fields.status !== undefined) {
                    const { status } = await pm.schemaShowStatus(fields.status);
                    if (status.roles.some((role) => ["terminal", "terminal_done", "terminal_canceled"].includes(role)))
                        fields.closeReason = "Azure DevOps state synchronized";
                }
                if (!equal(localValues(local, normalization), Object.fromEntries(Object.entries(values).filter(([key]) => key !== "relations"))) || fields.field.some((entry) => {
                    const split = entry.indexOf("=");
                    return String(local[entry.slice(0, split)] ?? "") !== entry.slice(split + 1);
                }))
                    await update(local.id, fields);
                let readback;
                const agreement = await advanceSyncBase({ expectedVersion: versions.get(local.id), minimumRemoteRevision: remote.rev,
                    readLocal: async () => { readback = await readLocalAgreement(pm, local.id, config, versions.get(local.id), normalization); return readback; },
                    readRemote: async (current) => {
                        const [actual] = await client.getWorkItems([remote.id]);
                        if (actual === undefined)
                            throw new CommandError("Azure item disappeared before agreement", EXIT_CODE.conflict);
                        return { revision: actual.rev, values: remoteAgreement(actual, current.values, config, readback.identities, states, exportStates, normalization) };
                    },
                    publish: async (base, revision) => {
                        await writes.assertCurrent(local.id);
                        const { field, unset } = agreementMutation(readback.item, base, revision);
                        if (field.length || unset !== undefined)
                            await persist(local.id, { field, unset, message: "Azure read-back agreement" }, "agreement");
                        if (revision !== undefined)
                            localPlans.delete(local.id);
                    } });
                if (agreement.differences.length)
                    conflicts.push({ pm_id: local.id, ado_id: remote.id,
                        stored_rev: local.ado_rev, remote_rev: agreement.remote.revision,
                        fields: Object.fromEntries(agreement.differences.map((key) => [key, { base: agreement.base[key], local: agreement.local.values[key], remote: agreement.remote.values[key] }])) });
            }
        }
        if (conflicts.length)
            return conflictResult();
        return { ok: true, dry_run: dryRun, plans, conflicts, diagnostics };
    }
    catch (error) {
        // A timestamp/read-back refusal may precede publication; recover the same structured native evidence.
        if (error instanceof CommandError && error.exitCode === EXIT_CODE.conflict && nativeWrites !== undefined && activeItem !== undefined) {
            try {
                await nativeWrites.assertCurrent(activeItem);
            }
            catch (current) {
                if (current instanceof NativeHistoryConflict)
                    error = current;
            }
        }
        const exitCode = error instanceof CommandError || error instanceof NativeHistoryConflict ? error.exitCode : EXIT_CODE.remote;
        return { ok: false, code: exitCode === EXIT_CODE.usage ? "ADO_USAGE" : exitCode === EXIT_CODE.conflict ? "ADO_CONFLICT" : "ADO_REMOTE",
            exit_code: exitCode, dry_run: dryRun, plans, conflicts, diagnostics,
            ...(error instanceof NativeHistoryConflict ? { kind: error.kind, sync_conflict: { code: error.kind, pm_id: error.item, fields: error.fields } } : {}),
            error: error instanceof CommandError || error instanceof NativeHistoryConflict ? error.message : "Azure DevOps command failed; check configuration, tracker validity and connectivity" };
    }
}
//# sourceMappingURL=sync.js.map