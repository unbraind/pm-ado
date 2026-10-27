import { normalizeScopeValue } from "./normalization.js";
import { AdoClient, batchIds, readConfig } from "./index.js";
import { ADO_FIELD_MAP, localValues, readBase, transport } from "./sync.js";
/** Typed, remedy-bearing failure shared by SDK and CLI callers. */
export class RefreshRefusal extends Error {
    /** Stable machine-readable category. */
    code;
    /** Concrete next action for the caller. */
    remedy;
    /** Host command exit status. */
    exitCode = 2;
    /** Construct a sanitized refusal without remote error bodies. */
    constructor(code) {
        const remedies = {
            invalid_input: "Use unique int32 IDs/revisions, dense bounded arrays, known fields and a 1024..1048576 byte budget; regenerate malformed base evidence.",
            scope: "Select links from this Azure organization and project only; repair duplicate identities before planning.",
            configuration: "Run inside an initialized pm tracker with ADO_ORG_URL, ADO_PROJECT and ADO_TOKEN; supply --fields as comma-separated native field names.",
            remote_failure: "Check tracker validity, read permissions and connectivity, then rerun the revision probe; never apply a saved refresh artifact as a write plan.",
            output_budget: "Select fewer linked items or raise --max-output-bytes up to 1048576; no receipt was truncated.",
        };
        super(remedies[code]);
        this.name = "RefreshRefusal";
        this.code = code;
        this.remedy = remedies[code];
    }
}
/** Require one strict schema predicate at an external boundary. */
function requireInput(value) { if (!value)
    throw new RefreshRefusal("invalid_input"); }
/** Accept plain records only, with exactly the documented keys. */
function record(value, required, optional = []) {
    requireInput(typeof value === "object" && value !== null && !Array.isArray(value));
    requireInput(required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => [...required, ...optional].includes(key)));
}
/** Dense arrays prevent holes from escaping Array.every and serializing as null. */
function dense(value, max) {
    requireInput(Array.isArray(value) && value.length <= max && Object.keys(value).length === value.length);
    for (let index = 0; index < value.length; index++)
        requireInput(Object.hasOwn(value, index));
}
/** Azure IDs and revisions are int32; every emitted count uses this domain too. */
function int32(value) { return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2147483647; }
/** Single strict request schema, reused when remote observations enter the compiler. */
export function validateRefreshInput(value) {
    record(value, ["needs", "saved"], ["observed", "maxOutputBytes"]);
    const fields = [...Object.keys(ADO_FIELD_MAP), "relations"];
    /** Validate an exact subset without normalizing caller data. */
    const subset = (input) => { dense(input, fields.length); requireInput(new Set(input).size === input.length && input.every((field) => typeof field === "string" && fields.includes(field))); };
    subset(value.needs);
    requireInput(value.needs.length > 0);
    dense(value.saved, 10000);
    for (const row of value.saved) {
        record(row, ["id", "revision", "base"]);
        requireInput(int32(row.id) && (row.revision === null || int32(row.revision)));
        subset(row.base);
    }
    requireInput(new Set(value.saved.map((row) => row.id)).size === value.saved.length);
    if (value.observed !== undefined) {
        dense(value.observed, value.saved.length);
        const ids = new Set(value.saved.map((row) => row.id));
        for (const row of value.observed) {
            record(row, ["id", "revision"]);
            requireInput(int32(row.id) && ids.has(row.id) && int32(row.revision));
        }
        requireInput(new Set(value.observed.map((row) => row.id)).size === value.observed.length);
    }
    if (value.maxOutputBytes !== undefined)
        requireInput(typeof value.maxOutputBytes === "number" && Number.isInteger(value.maxOutputBytes) && value.maxOutputBytes >= 1024 && value.maxOutputBytes <= 1048576);
}
/** Compile fresh revision evidence into deterministic minimum-round-trip batch reads. Never applies or persists a plan. */
export function compileRefreshPlan(input) {
    validateRefreshInput(input);
    const needs = [...input.needs].sort();
    const saved = [...input.saved].sort((a, b) => a.id - b.id);
    const observed = new Map(input.observed?.map((row) => [row.id, row.revision]));
    const unchanged = [], changed = [], unavailable = [];
    const accounting = needs.map((field) => ({ field, cached: 0, read: 0, unavailable: 0, pending: input.observed === undefined ? saved.length : 0 }));
    const pending = new Map();
    if (input.observed !== undefined)
        for (const row of saved) {
            const revision = observed.get(row.id);
            if (revision === undefined) {
                unavailable.push(row.id);
                for (const count of accounting)
                    count.unavailable++;
                continue;
            }
            const same = row.revision === revision;
            (same ? unchanged : changed).push(row.id);
            const missing = [];
            for (const count of accounting) {
                if (same && row.base.includes(count.field))
                    count.cached++;
                else {
                    count.read++;
                    missing.push(count.field);
                }
            }
            if (missing.length)
                pending.set(row.id, missing);
        }
    const probe = batchIds(saved.map((row) => row.id)).map((ids) => ({ ids, fields: ["System.Rev"], errorPolicy: "omit" }));
    const hydrate = batchIds([...pending.keys()]).map((ids) => {
        const fields = new Set(ids.flatMap((id) => pending.get(id)));
        return { ids, fields: ["System.Rev", ...[...fields].filter((field) => field !== "relations").map((field) => ADO_FIELD_MAP[field]).sort()],
            errorPolicy: "omit", ...(fields.has("relations") ? { $expand: "relations" } : {}) };
    });
    const plan = { ok: true, schema: "pm-ado/refresh/1", phase: input.observed === undefined ? "probe" : "refresh", probe, hydrate, unchanged, changed, unavailable,
        accounting, cost: { items: saved.length, probe_reads: probe.length, hydrate_reads: hydrate.length,
            field_cells: hydrate.reduce((sum, batch) => sum + batch.ids.length * (batch.fields.length - 1 + Number(batch.$expand === "relations")), 0), pm_mutations: 0 } };
    // All output numbers must remain bounded and finite, including derived costs.
    const numbers = [plan.cost.items, plan.cost.probe_reads, plan.cost.hydrate_reads, plan.cost.field_cells, plan.cost.pm_mutations,
        ...accounting.flatMap((row) => [row.cached, row.read, row.unavailable, row.pending])];
    requireInput(numbers.every((value) => Number.isInteger(value) && value >= 0 && value <= 100000));
    if (Buffer.byteLength(JSON.stringify(plan)) > (input.maxOutputBytes ?? 65536))
        throw new RefreshRefusal("output_budget");
    return plan;
}
/** Project only owned Azure evidence from an SDK-certified tracker snapshot, skipping unrelated/foreign records. */
export function refreshSaved(items, config) {
    const saved = [];
    for (const item of items) {
        if (item.ado_id === undefined || normalizeScopeValue(String(item.ado_org_url ?? ""), true) !== normalizeScopeValue(config.orgUrl, true) || normalizeScopeValue(String(item.ado_project ?? "")) !== normalizeScopeValue(config.project))
            continue;
        let base;
        // Sparse coverage coordinates need shape only; no semantic value comparison or native write occurs here.
        try {
            base = readBase(item, localValues(item, false), false);
        }
        catch {
            throw new RefreshRefusal("invalid_input");
        }
        saved.push({ id: Number(item.ado_id), revision: item.ado_rev === undefined ? null : Number(item.ado_rev),
            base: base === undefined ? [] : [...Object.keys(ADO_FIELD_MAP), ...(Array.isArray(base.relations) ? ["relations"] : [])] });
    }
    return saved;
}
/** Probe through the existing Azure batch client, compile remaining reads, and leave both trackers unchanged. */
export async function observeRefreshPlan(pm, config, request, needs, maxOutputBytes) {
    try {
        const items = (await pm.listAllComplete()).items;
        const saved = refreshSaved(items, config);
        const input = { saved, needs, maxOutputBytes };
        const initial = compileRefreshPlan(input); // Refuse invalid selection and receipt budget before any request.
        const result = await new AdoClient(config, request).getWorkItemsReport(initial.probe.flatMap((batch) => batch.ids), { fields: ["System.Rev"] });
        const currentItems = (await pm.listAllComplete()).items;
        const currentSaved = refreshSaved(currentItems, config);
        if (JSON.stringify(currentSaved.map((row) => row.id).sort((a, b) => a - b)) !== JSON.stringify(saved.map((row) => row.id).sort((a, b) => a - b)))
            throw new RefreshRefusal("scope");
        const plan = compileRefreshPlan({ ...input, saved: currentSaved, observed: result.items.map((item) => ({ id: item.id, revision: item.rev })) });
        plan.skipped = [
            { reason: "unlinked", count: currentItems.filter((item) => item.ado_id === undefined).length },
            { reason: "foreign_scope", count: currentItems.filter((item) => item.ado_id !== undefined && (normalizeScopeValue(String(item.ado_org_url ?? ""), true) !== normalizeScopeValue(config.orgUrl, true) || normalizeScopeValue(String(item.ado_project ?? "")) !== normalizeScopeValue(config.project))).length },
        ];
        if (Buffer.byteLength(JSON.stringify(plan)) > (maxOutputBytes ?? 65536))
            throw new RefreshRefusal("output_budget");
        return plan;
    }
    catch (error) {
        if (error instanceof RefreshRefusal)
            throw error;
        throw new RefreshRefusal("remote_failure");
    }
}
/** Delegate complete reads and TOON/JSON rendering to the host SDK, without git or mutation APIs. */
export async function runRefreshCommand(ctx) {
    try {
        const config = readConfig(process.env), fields = ctx.options.fields;
        if (!config || !ctx.sdk?.client || typeof fields !== "string")
            throw new RefreshRefusal("configuration");
        const maxOutputBytes = ctx.options.maxOutputBytes ?? ctx.options["max-output-bytes"];
        return await observeRefreshPlan(ctx.sdk.client, config, transport, fields.split(","), maxOutputBytes);
    }
    catch (error) {
        const refusal = error instanceof RefreshRefusal ? error : new RefreshRefusal("remote_failure");
        process.exitCode = refusal.exitCode;
        return { ok: false, code: refusal.code, remedy: refusal.remedy, exit_code: refusal.exitCode };
    }
}
//# sourceMappingURL=refresh.js.map