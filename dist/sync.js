import { normalizeFieldValues, normalizeStatusValue, normalizeAssigneeValue, normalizeItemReference, normalizeScopeValue, normalizeStateMaps } from "./normalization.js";
/** Command orchestration and per-field Azure DevOps reconciliation. */
import { advanceSyncBase, readBaseRevisions } from "./agreement.js";
import { loadResolutionSdk, resolutionDigest } from "./resolution.js";
import { SyncOutbox, isProtocolTag } from "./sync-outbox.js";
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
    const base = parsed;
    for (const [key, value] of Object.entries(sample)) {
        if (base.ado_base_partial === 1 && !Object.hasOwn(base, key))
            continue;
        if (Array.isArray(value) ? !Array.isArray(base[key]) || base[key].some((entry) => typeof entry !== "string")
            : typeof base[key] !== typeof value)
            throw new CommandError(`Invalid ado_sync_base field: ${key}`);
    }
    return normalization === false ? base : normalizeFieldValues(base, normalization);
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
/** Choose each key from its witnessed base or the latest proof for that exact owned scalar. */
export function mergeSyncValues(local, remote, base, effect, normalization) {
    local = normalizeFieldValues(local, normalization);
    remote = normalizeFieldValues(remote, normalization);
    if (base !== undefined)
        base = normalizeFieldValues(base, normalization);
    const witnessed = readBaseRevisions(base);
    const effects = (effect === undefined ? [] : Array.isArray(effect) ? effect : [effect]).map((candidate) => ({ ...candidate,
        original: normalizeFieldValues(candidate.original, normalization), accepted: normalizeFieldValues(candidate.accepted, normalization) }));
    return Object.fromEntries(Object.keys(remote).map((key) => {
        const owned = key === "relations" ? undefined : [...effects].reverse().find((candidate) => candidate.keys.includes(key) && (witnessed[key] ?? 0) <= candidate.revision);
        return [key, equal(local[key], remote[key]) ? "equal" :
                owned !== undefined ? recoveredField(local[key], remote[key], owned.original[key], owned.accepted[key]) :
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
    const dryRun = ctx.options.dryRun === true || ctx.options["dry-run"] === true;
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
        let { items } = snapshot;
        let versions = new Map(items.map((item) => [item.id, item.updated_at]));
        const localPlans = new Map();
        const foreignKeys = new Map();
        const ownedKeys = new Map();
        const localGoals = new Map();
        const localSeen = new Map();
        const localRemote = new Map(items.flatMap((item) => Number.isSafeInteger(item.ado_id) && Number.isSafeInteger(item.ado_rev) && Number(item.ado_rev) > 0
            ? [[item.id, { id: Number(item.ado_id), revision: Number(item.ado_rev) }]] : []));
        const scope = resolutionDigest([config.orgUrl, config.project]);
        /** Write one SDK mutation, carrying only this command's immutable history revision. */
        const commitLocal = async (id, options, operation, transactionId) => {
            const expected = versions.get(id);
            await observer?.({ boundary: "local", phase: "before", operation, item: id });
            try {
                await sdk.commitItemMutations({ pmRoot: ctx.pm_root, transactionId, author,
                    mutations: [{ op: "update", id, options, match: { key: "updated_at", value: expected } }] });
            }
            catch (error) {
                if (error instanceof sdk.PmCliError && error.exitCode === EXIT_CODE.conflict)
                    throw new CommandError("Local sync persistence refused; re-read both trackers and retry. Earlier Azure or pm operations may have succeeded.", EXIT_CODE.conflict);
                throw error;
            }
            await observer?.({ boundary: "local", phase: "after", operation, item: id });
            const history = await sdk.readHistorySnapshot(sdk.getHistoryPath(ctx.pm_root, id), id);
            const own = history.entries.filter((entry) => entry.message?.startsWith(`bulk-item-transaction ${transactionId} `)).at(-1);
            versions.set(id, own?.ts ?? expected);
        };
        /** Persist the integration plan before its first native effect; agreement clears it atomically. */
        const persist = async (id, options, operation = "update", suffix) => {
            let pending = localPlans.get(id);
            if (pending === undefined && operation !== "agreement") {
                const version = versions.get(id);
                pending = { schema: "pm-ado/local/1", scope, version, plan: resolutionDigest([scope, id, version]),
                    wanted: structuredClone(localGoals.get(id) ?? localValues(items.find((item) => item.id === id), normalization)), seen: structuredClone(localSeen.get(id) ?? {}), remote: localRemote.get(id) };
                await commitLocal(id, { field: [`ado_sync_intent=${JSON.stringify(pending)}`], message: "Prepare mapped local writes" }, "local-prepared", `ado-local-${pending.plan}`);
                localPlans.set(id, pending);
            }
            const goal = localGoals.get(id);
            const seen = localSeen.get(id);
            if (operation !== "agreement" && pending !== undefined && goal !== undefined && (!equal(pending.wanted, goal) || seen !== undefined && !equal(pending.seen, seen) || !equal(pending.remote, localRemote.get(id)))) {
                pending.wanted = structuredClone(goal);
                if (seen !== undefined)
                    pending.seen = structuredClone(seen);
                pending.remote = localRemote.get(id);
                await commitLocal(id, { field: [`ado_sync_intent=${JSON.stringify(pending)}`], message: "Refresh mapped local intent" }, "local-replanned", `ado-sync-${pending.plan}-${sdk.deriveMutationTransactionId(JSON.stringify([versions.get(id), pending]))}`);
            }
            const transactionId = `ado-sync-${pending?.plan ?? "agreement"}-${suffix ?? sdk.deriveMutationTransactionId(JSON.stringify([id, versions.get(id), options]))}`;
            await commitLocal(id, options, operation, transactionId);
        };
        /** Recovery ownership applies to every actual graph endpoint, independent of query selection. */
        const guardRelationUpdate = async (id, options) => {
            const relationWrite = options.parent !== undefined || options.dep !== undefined ||
                options.unset?.some((key) => key === "parent" || key === "dependencies");
            if (mode !== "sync" || !relationWrite)
                return;
            let changed = foreignKeys.get(id)?.has("relations") === true;
            if (!changed && !ownedKeys.get(id)?.has("relations") && items.some((item) => item.id === id)) {
                const local = await readLocalAgreement(snapshotReader, id, config, undefined, normalization);
                changed = !equal(local.values.relations, local.base?.relations);
            }
            if (changed)
                throw new CommandError(`Local relations changed at affected endpoint ${id}; re-read both trackers and resolve that endpoint before retrying`, EXIT_CODE.conflict);
        };
        /** Keep native close and mapped assignment replayable without treating native clearing as a local edit. */
        const update = async (id, options) => {
            await guardRelationUpdate(id, options);
            if (options.status !== sdk.resolveRuntimeStatusRegistry(settings.schema).close_status)
                return persist(id, options);
            const { status, closeReason, completedAt, ...scalars } = options;
            await persist(id, scalars);
            const pending = localPlans.get(id);
            const transaction = `close-${resolutionDigest([versions.get(id), status, closeReason, scalars.assignee ?? ""])}`;
            pending.close = { status, assignee: scalars.assignee ?? "", transaction };
            await persist(id, { field: [`ado_sync_intent=${JSON.stringify(pending)}`], message: "Prepare mapped close assignment" }, "close-prepared");
            await persist(id, { status, closeReason: closeReason, completedAt, force: options.force }, "close", transaction);
            if (pending.close.assignee !== "")
                await persist(id, { assignee: pending.close.assignee }, "assignment");
        };
        let recoveredLocal = false;
        for (const item of items.filter((row) => row.ado_sync_intent !== undefined)) {
            let pending;
            try {
                pending = JSON.parse(String(item.ado_sync_intent));
            }
            catch {
                throw new CommandError("Invalid local sync intent", EXIT_CODE.conflict);
            }
            if (typeof pending !== "object" || pending === null || pending.schema !== "pm-ado/local/1" || pending.scope !== scope ||
                typeof pending.version !== "string" || pending.plan !== resolutionDigest([scope, item.id, pending.version]) ||
                typeof pending.wanted !== "object" || pending.wanted === null || Array.isArray(pending.wanted) ||
                typeof pending.seen !== "object" || pending.seen === null || Array.isArray(pending.seen) ||
                pending.remote !== undefined && (typeof pending.remote !== "object" || pending.remote === null || !Number.isSafeInteger(pending.remote.id) || pending.remote.id < 1 ||
                    !Number.isSafeInteger(pending.remote.revision) || pending.remote.revision < 1 || item.ado_id !== undefined && item.ado_id !== pending.remote.id) ||
                pending.close !== undefined && (typeof pending.close !== "object" || pending.close === null || typeof pending.close.status !== "string" ||
                    typeof pending.close.assignee !== "string" || !/^close-[a-f0-9]{64}$/u.test(pending.close.transaction)))
                throw new CommandError("Invalid local sync intent", EXIT_CODE.conflict);
            localPlans.set(item.id, pending);
            const history = (await sdk.readHistorySnapshot(sdk.getHistoryPath(ctx.pm_root, item.id), item.id)).entries;
            const prepared = history.map((entry) => entry.message?.startsWith(`bulk-item-transaction ado-local-${pending.plan} `) === true).lastIndexOf(true);
            if (prepared < 0 || history.slice(prepared + 1).some((entry) => entry.patch.some((patch) => patch.path === "/metadata/ado_sync_intent") &&
                !entry.message?.startsWith(`bulk-item-transaction ado-sync-${pending.plan}-`)))
                throw new CommandError("Local sync intent lacks its SDK history proof", EXIT_CODE.conflict);
            // Keep original plan/history coordinates opaque; compare every older semantic field in native form.
            pending.wanted = normalizeFieldValues(pending.wanted, normalization);
            pending.seen = normalizeFieldValues(pending.seen, normalization);
            const latest = new Map();
            for (const entry of history.slice(prepared + 1))
                for (const patch of entry.patch) {
                    const field = patch.path.split("/")[2];
                    const key = ["parent", "dependencies"].includes(field) ? "relations" : field;
                    if (Object.hasOwn(ADO_FIELD_MAP, key) || key === "relations")
                        latest.set(key, entry.message?.startsWith(`bulk-item-transaction ado-sync-${pending.plan}-`) !== true);
                }
            const foreign = new Set([...latest].filter(([, changed]) => changed).map(([key]) => key));
            foreignKeys.set(item.id, foreign);
            ownedKeys.set(item.id, new Set([...latest].filter(([, changed]) => !changed).map(([key]) => key)));
            const closing = pending.close;
            if (closing !== undefined && !foreign.has("status") && !foreign.has("assignee") && normalizeStatusValue(item.status, normalization) === normalizeStatusValue(closing.status, normalization) &&
                normalizeAssigneeValue(item.assignee ?? "", normalization) !== normalizeAssigneeValue(closing.assignee, normalization) && history.some((entry) => entry.message?.startsWith(`bulk-item-transaction ado-sync-${pending.plan}-${closing.transaction} `))) {
                if (dryRun)
                    throw new CommandError("Pending native close requires SDK recovery; run sync before planning again", EXIT_CODE.conflict);
                await persist(item.id, assignmentFields(normalizeAssigneeValue(closing.assignee, normalization)), "assignment-recovery");
                recoveredLocal = true;
            }
        }
        if (recoveredLocal) {
            snapshot = await pm.listAllComplete();
            items = snapshot.items;
            versions = new Map(items.map((item) => [item.id, item.updated_at]));
        }
        const snapshotReader = { listAllComplete: async () => snapshot };
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
                    keys: Object.keys(ADO_FIELD_MAP).filter((key) => Object.hasOwn(recovery.fields, ADO_FIELD_MAP[key])), revision: recovery.revision }))]);
        }
        const pairs = mode === "export" ? selected.map((local) => ({ local, remote: remotes.get(Number(local.ado_id)) }))
            : [...remotes.values()].map((remote) => ({ remote, local: items.find((item) => item.id === identities.get(remote.id)) }));
        const paired = new Set(pairs.map((pair) => pair.local?.id));
        if (mode === "sync")
            for (const local of items.filter((item) => item.ado_id === undefined && !paired.has(item.id)).slice(0, limit - pairs.length))
                pairs.push({ local, remote: undefined });
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
            const minimum = Math.max(0, ...Object.values(readBaseRevisions(storedBase)), localPlans.get(local.id)?.remote?.revision ?? 0);
            if (remote.rev < minimum)
                throw new CommandError("Azure returned an older revision than durable local recovery; re-read both trackers", EXIT_CODE.conflict);
            const base = mode === "import" ? undefined : storedBase;
            const effect = effects.get(local.id);
            // Preserve a locally distinct status whose configured Azure representation
            // is unchanged (the default blocked and in_progress both export Active).
            if (mode !== "import")
                r.status = remoteScalarValues(remote, base, states, exportStates, normalization).status;
            const decisions = mergeSyncValues(l, r, base, effect, normalization);
            const differing = {};
            for (const key of Object.keys(r)) {
                if (mode === "import") {
                    values[key] = r[key];
                    if (!equal(l[key], r[key]))
                        plan.import_fields.push(key);
                }
                else if (mode === "export") {
                    values[key] = l[key];
                    if (!equal(l[key], r[key]))
                        plan.export_fields.push(key);
                }
                else if (!equal(l[key], r[key]) && foreignKeys.get(local.id)?.has(key))
                    differing[key] = { base: base?.[key], local: l[key], remote: r[key] };
                else if (!equal(l[key], r[key]) && ownedKeys.get(local.id)?.has(key)) {
                    if (!equal(l[key], localPlans.get(local.id).wanted[key]) || !equal(localPlans.get(local.id).wanted[key], localPlans.get(local.id).seen[key]))
                        differing[key] = { base: base?.[key], local: l[key], remote: r[key] };
                    else {
                        values[key] = r[key];
                        plan.import_fields.push(key);
                    }
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
            if (plan.export_fields.length && !effects.has(local.id) && (!Number.isSafeInteger(local.ado_rev) || Number(local.ado_rev) < 1)) {
                throw new CommandError(`Missing valid ado_rev for ${local.id}; import first`);
            }
            if (dryRun && mode === "export" && plan.export_fields.length && local.ado_rev !== remote.rev) {
                conflicts.push(revisionConflict(entry, new RevisionConflict(remote.id, Number(local.ado_rev), remote), config, identities, states));
            }
            // Validate export mappings even in dry-run, before any write on either side.
            azureFields(values, plan.export_fields, exportStates, normalization);
        }
        if (mode === "sync" && conflicts.length === 0) {
            const pulled = entries.filter((entry) => entry.pullRelations && entry.remote !== undefined).map((entry) => entry.remote);
            if (pulled.length) {
                const footprint = await planRelationImport(pulled, config.orgUrl, identities, snapshotReader, {}, true);
                for (const { id, options } of footprint.updates)
                    await guardRelationUpdate(id, options);
            }
        }
        if (conflicts.length)
            return { ok: false, code: "ADO_CONFLICT", exit_code: EXIT_CODE.conflict, dry_run: dryRun, plans, conflicts, diagnostics };
        if (!dryRun) {
            for (const entry of entries)
                if (entry.local !== undefined) {
                    localGoals.set(entry.local.id, entry.values);
                    if (entry.remote !== undefined) {
                        localSeen.set(entry.local.id, remoteAgreement(entry.remote, entry.values, config, identities, states, exportStates, normalization));
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
                        localSeen.set(local.id, remoteAgreement(remote, values, config, identities, states, exportStates, normalization));
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
                        remote = await outbox.patch(local.id, { ...remote, rev: mode === "sync" ? remote.rev : Number(local.ado_rev) }, azureFields(values, plan.export_fields, exportStates, normalization), entry.operations, localValues(local, normalization));
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
                    localSeen.set(local.id, remoteAgreement(entry.remote, values, config, identities, states, exportStates, normalization));
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
                    localGoals.set(item.id, entry.values);
                    localSeen.set(item.id, remoteAgreement(entry.remote, values, config, identities, states, exportStates, normalization));
                    localRemote.set(item.id, { id: remote.id, revision: remote.rev });
                    versions.set(item.id, item.updated_at);
                    plan.pm_id = item.id;
                    identities.set(remote.id, item.id);
                }
                plan.ado_id = remote.id;
            }
            // A 412 leaves its local item and history untouched, including inverse links.
            if (conflicts.length)
                return { ok: false, code: "ADO_CONFLICT", exit_code: EXIT_CODE.conflict, dry_run: false, plans, conflicts, diagnostics };
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
                return { ok: false, code: "ADO_CONFLICT", exit_code: EXIT_CODE.conflict, dry_run: false, plans, conflicts, diagnostics };
            const pulled = entries.filter((entry) => entry.pullRelations).map((entry) => entry.remote);
            if (pulled.length)
                diagnostics.push(...(await importRelations(pulled, config.orgUrl, identities, { listAllComplete: () => pm.listAllComplete(), update })).unmapped);
            for (const entry of entries) {
                const { values, remote, local } = entry;
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
                        const field = [];
                        if (readback.item.ado_sync_base !== JSON.stringify(base))
                            field.push(`ado_sync_base=${JSON.stringify(base)}`);
                        if (revision !== undefined && readback.item.ado_rev !== revision)
                            field.push(`ado_rev=${revision}`);
                        const unset = revision !== undefined && readback.item.ado_sync_intent !== undefined ? ["ado_sync_intent"] : undefined;
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
            return { ok: false, code: "ADO_CONFLICT", exit_code: EXIT_CODE.conflict, dry_run: dryRun, plans, conflicts, diagnostics };
        return { ok: true, dry_run: dryRun, plans, conflicts, diagnostics };
    }
    catch (error) {
        const exitCode = error instanceof CommandError ? error.exitCode : EXIT_CODE.remote;
        return { ok: false, code: exitCode === EXIT_CODE.usage ? "ADO_USAGE" : exitCode === EXIT_CODE.conflict ? "ADO_CONFLICT" : "ADO_REMOTE",
            exit_code: exitCode, dry_run: dryRun, plans, conflicts, diagnostics,
            error: error instanceof CommandError ? error.message : "Azure DevOps command failed; check configuration, tracker validity and connectivity" };
    }
}
//# sourceMappingURL=sync.js.map