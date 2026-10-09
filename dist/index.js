// pm-ado — Azure DevOps work item sync for pm-cli.
//
// The design point of this package is that Azure DevOps is the one major
// tracker whose write API is natively conflict-aware. Work items are updated
// with a JSON Patch document, and that document may carry a `test` operation
// asserting the current `System.Rev`. When another writer moved the item first
// the service rejects the WHOLE document rather than applying part of it, so a
// lost update becomes a visible, retryable failure instead of silent data loss.
//
// That is a compare-and-swap on a remote tracker, and it is the primitive pm
// already organises itself around for multi-agent work. Every other integration
// in this fleet performs last-write-wins updates. This one does not, so every
// remote write here asserts a revision — there is no unchecked write path to
// fall back to, by construction rather than by convention.
/**
 * Semantic exit codes pm's command runtime propagates to the shell.
 *
 * Mirrored here rather than imported because a standalone-installed extension
 * loads only its own `dist/`, so `@unbrained/pm-cli` is not resolvable at
 * runtime. {@link CommandError} carries one of these so a handled failure exits
 * cleanly once instead of re-invoking the handler.
 */
export const EXIT_CODE = {
    /** The invocation was malformed or missing required configuration. */
    usage: 2,
    /** A remote call failed, or the service returned an unusable response. */
    remote: 3,
    /** A write lost a revision race and the caller must re-read and retry. */
    conflict: 4,
};
/**
 * An error carrying the exit code pm's runtime should exit with.
 *
 * pm treats a thrown error as a cleanly handled non-zero exit only when it
 * carries a numeric `exitCode`; a plain `Error` makes the runtime fall through
 * to its unhandled path, which re-invokes the handler and doubles any side
 * effect already performed.
 */
export class CommandError extends Error {
    /** The exit code pm's command runtime should terminate with. */
    exitCode;
    /**
     * Construct a handled command failure.
     *
     * @param message - Operator-facing description of what went wrong.
     * @param exitCode - One of {@link EXIT_CODE}; defaults to a usage failure.
     */
    constructor(message, exitCode = EXIT_CODE.usage) {
        super(message);
        this.name = "CommandError";
        this.exitCode = exitCode;
    }
}
/** The media type Azure DevOps requires for a work item patch document. */
export const PATCH_MEDIA_TYPE = "application/json-patch+json";
/**
 * Azure DevOps relation reference names mapped to the pm concepts they mean.
 *
 * Azure DevOps relations are typed rather than free-form, which is why they can
 * be mapped at all: each name already carries the meaning pm expresses as a
 * parent link or a dependency kind. `Hierarchy-Reverse` points at the PARENT
 * (the reverse end of a parent-to-child link), which is the direction most
 * often got backwards.
 */
export const RELATION_MAP = {
    "System.LinkTypes.Hierarchy-Reverse": "parent",
    "System.LinkTypes.Hierarchy-Forward": "child",
    "System.LinkTypes.Related": "related",
    "System.LinkTypes.Duplicate-Forward": "duplicate",
    "System.LinkTypes.Duplicate-Reverse": "duplicated_by",
    "System.LinkTypes.Dependency-Reverse": "blocked_by",
    "System.LinkTypes.Dependency-Forward": "blocks",
};
/** Resolve explicit custom mappings without accepting inherited object properties. */
function relationKind(rel, custom) {
    if (Object.hasOwn(custom, rel)) {
        if (!/^[A-Za-z0-9_.-]+$/u.test(rel) || Object.hasOwn(RELATION_MAP, rel)) {
            throw new CommandError(`invalid custom relation reference: ${rel}`);
        }
        return custom[rel];
    }
    return Object.hasOwn(RELATION_MAP, rel) ? RELATION_MAP[rel] : undefined;
}
/** Canonicalize SDK hierarchy aliases and store Duplicate with its original reference name. */
function storedRelationKind(kind) {
    if (kind === "duplicate" || kind === "duplicated_by" || kind === "related_to")
        return "related";
    if (kind === "child_of" || kind === "epic")
        return "parent";
    if (kind === "parent_child" || kind === "task")
        return "child";
    return kind;
}
/** Reject ambiguous or dangling identity tables before planning either direction. */
function assertRelationIdentities(identities, items) {
    const local = new Set(items.map((item) => item.id));
    const seen = new Set();
    for (const [remote, id] of identities) {
        if (!Number.isSafeInteger(remote) || remote <= 0 || !local.has(id) || seen.has(id)) {
            throw new CommandError("relation identities must be unique safe IDs naming existing pm items");
        }
        seen.add(id);
    }
}
/**
 * Merge a remote relation batch into real pm hierarchy and dependencies.
 *
 * Read the complete tracker before writing; validate the entire proposed hierarchy,
 * including existing hierarchy dependencies, so remote cycles and competing parents
 * leave every item untouched. Apply parents before descendants in the validated
 * final tree, avoiding transient cycles without detaching existing parents. If a
 * write fails, restore completed parent changes in reverse order; failed recovery
 * reports the exact detached IDs from a fresh tracker read. Dependency source_kind retains exact ADO reference names,
 * including custom types and both Duplicate directions (stored as related because the
 * SDK mutation parser does not accept a duplicate kind). This is an additive import:
 * absent remote links do not erase independently maintained local links.
 *
 * @param remote - Relation snapshots read through the batch client.
 * @param orgUrl - Organization scope used to validate every relation target.
 * @param identities - One-to-one remote-to-local identity table.
 * @param pm - Caller-owned SDK client bound to the target tracker.
 * @param custom - Explicit custom reference-name mappings.
 * @returns Changed local IDs and original edges that could not be imported.
 */
export async function importRelations(remote, orgUrl, identities, pm, custom = {}) {
    const { items } = await pm.listAllComplete();
    assertRelationIdentities(identities, items);
    const parents = new Map(items.map((item) => [item.id, item.parent]));
    const proposed = new Map();
    const additions = new Map();
    const seen = new Set(items.flatMap((item) => (item.dependencies ?? []).map((dep) => JSON.stringify([item.id, dep.id, dep.kind, dep.source_kind]))));
    const native = new Set(items.flatMap((item) => (item.dependencies ?? [])
        .filter((dep) => relationKind(dep.source_kind ?? "", custom) === undefined)
        .map((dep) => JSON.stringify([item.id, dep.id, storedRelationKind(dep.kind)]))));
    const unmapped = [];
    for (const item of remote) {
        const source = identities.get(item.id);
        if (source === undefined)
            throw new CommandError(`missing pm identity for work item ${item.id}`);
        for (const relation of item.relations ?? []) {
            const mapped = relationKind(relation.rel, custom);
            const targetId = relationTargetId(relation.url, orgUrl);
            const target = targetId === undefined ? undefined : identities.get(targetId);
            if (mapped === undefined || target === undefined) {
                unmapped.push({ itemId: item.id, relation });
                continue;
            }
            const kind = storedRelationKind(mapped);
            if (kind === "parent" || kind === "child") {
                const child = kind === "parent" ? source : target;
                const parent = kind === "parent" ? target : source;
                const previous = proposed.get(child);
                if (previous !== undefined && previous !== parent) {
                    throw new CommandError(`conflicting remote parents for ${child}`, EXIT_CODE.conflict);
                }
                proposed.set(child, parent);
                parents.set(child, parent);
            }
            else {
                const key = JSON.stringify([source, target, kind, relation.rel]);
                const nativeEquivalent = RELATION_MAP[relation.rel] === kind && native.has(JSON.stringify([source, target, kind]));
                if (!seen.has(key) && !nativeEquivalent) {
                    const deps = additions.get(source) ?? [];
                    deps.push(`id=${target},kind=${kind},source_kind=${relation.rel}`);
                    additions.set(source, deps);
                    seen.add(key);
                }
            }
        }
    }
    // Include legacy hierarchy dependencies as well as the parent field. Kahn's
    // algorithm avoids recursion depth limits and checks disconnected components.
    const children = new Map();
    const incoming = new Map();
    const edges = [];
    for (const [child, parent] of parents) {
        incoming.set(child, 0);
        if (parent !== undefined)
            edges.push([parent, child]);
    }
    for (const item of items) {
        for (const dep of item.dependencies ?? []) {
            const kind = storedRelationKind(dep.kind);
            if (kind === "parent")
                edges.push([dep.id, item.id]);
            if (kind === "child")
                edges.push([item.id, dep.id]);
        }
    }
    for (const [parent, child] of edges) {
        const outgoing = children.get(parent) ?? new Set();
        if (!outgoing.has(child)) {
            outgoing.add(child);
            children.set(parent, outgoing);
            incoming.set(child, (incoming.get(child) ?? 0) + 1);
        }
        if (!incoming.has(parent))
            incoming.set(parent, 0);
    }
    const queue = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
    for (let index = 0; index < queue.length; index++) {
        for (const child of children.get(queue[index]) ?? []) {
            const count = incoming.get(child) - 1;
            incoming.set(child, count);
            if (count === 0)
                queue.push(child);
        }
    }
    if (queue.length !== incoming.size) {
        throw new CommandError("remote relations would create a hierarchy cycle", EXIT_CODE.conflict);
    }
    const changedParents = new Set(items.filter((item) => proposed.has(item.id) && item.parent !== proposed.get(item.id))
        .map((item) => item.id));
    const byId = new Map(items.map((item) => [item.id, item]));
    const completed = [];
    const updated = new Set();
    try {
        // Final-tree order gives the minimal detach set: empty. Every changed
        // ancestor has its final parent before a descendant can point back to it.
        for (const id of queue) {
            const item = byId.get(id);
            if (item === undefined)
                continue;
            const parentChanged = changedParents.has(id);
            const dep = additions.get(id) ?? [];
            if (parentChanged || dep.length > 0) {
                await pm.update(id, { ...(parentChanged ? { parent: proposed.get(id) } : {}), dep });
                if (parentChanged)
                    completed.push(item);
                updated.add(id);
            }
        }
    }
    catch (error) {
        const failed = [];
        for (const item of completed.reverse()) {
            try {
                await pm.update(item.id, item.parent === undefined ? { unset: ["parent"] } : { parent: item.parent });
            }
            catch {
                failed.push(item.id);
            }
        }
        if (failed.length > 0) {
            const current = new Map((await pm.listAllComplete()).items.map((item) => [item.id, item.parent]));
            const detached = items.filter((item) => item.parent !== undefined && current.get(item.id) === undefined)
                .map((item) => item.id);
            const failure = new CommandError(`${String(error)}; parent restoration failed for: ${failed.join(", ")}; detached IDs: ${detached.join(", ") || "none"}`, EXIT_CODE.conflict);
            failure.cause = error;
            throw failure;
        }
        throw error;
    }
    return { updated: [...updated], unmapped };
}
/**
 * Plan a minimal relation patch from a complete pm tracker and a remote snapshot.
 *
 * Existing reference names and attributes survive when their local edge survives.
 * Unknown types, unsafe URLs and targets outside the identity table are reported
 * and retained. Duplicate copies of recognized edges are removed by descending
 * index; new edges are appended once. source_kind preserves custom/Duplicate
 * identities even when multiple reference names share one pm kind. The caller
 * passes the returned operations to updateWorkItem with remote.rev; an empty patch
 * needs no write. Remote fields are not changed by this planner.
 *
 * @param remote - Revision-bearing snapshot with relations expanded.
 * @param orgUrl - Organization used for canonical relation URLs.
 * @param identities - One-to-one work-item/pm identity table.
 * @param pm - Caller-owned SDK client bound to the target tracker.
 * @param custom - Explicit custom reference-name mappings.
 * @returns Relation operations and both remote and local unmapped-edge receipts.
 */
export async function exportRelations(remote, orgUrl, identities, pm, custom = {}) {
    if (remote.relations === undefined)
        throw new CommandError("export requires an expanded relations snapshot");
    const { items } = await pm.listAllComplete();
    assertRelationIdentities(identities, items);
    const source = identities.get(remote.id);
    if (source === undefined)
        throw new CommandError(`missing pm identity for work item ${remote.id}`);
    const local = items.find((item) => item.id === source);
    const reverse = new Map([...identities].map(([id, pmId]) => [pmId, id]));
    const desired = new Map();
    const unmappedLocal = [];
    const candidates = [
        ...(local.parent === undefined ? [] : [{ id: local.parent, kind: "parent" }]),
        ...items.filter((item) => item.parent === source).map((item) => ({ id: item.id, kind: "child" })),
        ...(local.dependencies ?? []),
    ];
    // ADO exposes both ends of dependency links. Materialize the inverse from
    // incoming pm dependencies even when only one end was imported or authored.
    for (const item of items) {
        for (const dep of item.dependencies ?? []) {
            if (dep.id !== source)
                continue;
            const kind = storedRelationKind(dep.kind);
            const original = dep.source_kind;
            if (kind === "blocks" || kind === "blocked_by" || kind === "related") {
                const inverseKind = kind === "blocks" ? "blocked_by" : kind === "blocked_by" ? "blocks" : "related";
                let inverse = original;
                if (kind !== "related") {
                    const customInverses = original !== undefined && Object.hasOwn(custom, original)
                        ? Object.entries(custom).filter(([, value]) => value === inverseKind) : [];
                    if (customInverses.length > 1) {
                        unmappedLocal.push({ id: source, kind: inverseKind, target: item.id, source_kind: original });
                        continue;
                    }
                    inverse = customInverses[0]?.[0] ?? Object.entries(RELATION_MAP).find(([, value]) => value === inverseKind)?.[0];
                }
                else if (original === "System.LinkTypes.Duplicate-Forward") {
                    inverse = "System.LinkTypes.Duplicate-Reverse";
                }
                else if (original === "System.LinkTypes.Duplicate-Reverse") {
                    inverse = "System.LinkTypes.Duplicate-Forward";
                }
                candidates.push({ ...dep, id: item.id, kind: inverseKind, source_kind: inverse });
            }
            else if (kind === "parent" || kind === "child") {
                candidates.push({ ...dep, id: item.id, kind: kind === "parent" ? "child" : "parent", source_kind: undefined });
            }
        }
    }
    for (const dep of candidates) {
        const kind = storedRelationKind(dep.kind);
        const provenance = "source_kind" in dep ? dep.source_kind : undefined;
        const provenanceKind = provenance === undefined ? undefined : relationKind(provenance, custom);
        if (provenance !== undefined && !provenance.includes(":") &&
            (provenanceKind === undefined || storedRelationKind(provenanceKind) !== kind)) {
            unmappedLocal.push({ id: source, kind, target: dep.id });
            continue;
        }
        const rel = provenanceKind !== undefined && storedRelationKind(provenanceKind) === kind
            ? provenance
            : Object.entries({ ...RELATION_MAP, ...custom }).find(([, value]) => value === kind)?.[0];
        const targetId = reverse.get(dep.id);
        if (rel === undefined || targetId === undefined) {
            unmappedLocal.push({ id: source, kind, target: dep.id });
            continue;
        }
        const url = `${stripTrailingSlashes(orgUrl)}/_apis/wit/workItems/${targetId}`;
        if (relationTargetId(url, orgUrl) !== targetId)
            throw new CommandError("export requires a canonical organization URL");
        desired.set(`${rel}:${targetId}`, { rel, url });
    }
    const retained = new Set();
    const remove = [];
    const unmapped = [];
    for (const [index, relation] of remote.relations.entries()) {
        const mapped = relationKind(relation.rel, custom);
        const targetId = relationTargetId(relation.url, orgUrl);
        if (mapped === undefined || targetId === undefined || !identities.has(targetId)) {
            unmapped.push({ itemId: remote.id, relation });
            continue;
        }
        if (unmappedLocal.some((dep) => dep.source_kind !== undefined && dep.target === identities.get(targetId) &&
            dep.kind === storedRelationKind(mapped))) {
            unmapped.push({ itemId: remote.id, relation });
            continue;
        }
        const key = `${relation.rel}:${targetId}`;
        // Hierarchy has no dependency provenance. Preserve every existing distinct
        // reference name for a surviving edge, without inventing a built-in alias.
        if (storedRelationKind(mapped) === "parent" || storedRelationKind(mapped) === "child") {
            const equivalent = [...desired].find(([, value]) => storedRelationKind(relationKind(value.rel, custom)) === storedRelationKind(mapped) &&
                relationTargetId(value.url, orgUrl) === targetId);
            if (equivalent !== undefined && equivalent[0] !== key) {
                if (!retained.has(equivalent[0]))
                    desired.delete(equivalent[0]);
                desired.set(key, relation);
            }
        }
        if (desired.has(key) && !retained.has(key))
            retained.add(key);
        else
            remove.push(index);
    }
    const operations = remove.reverse().map((index) => ({ op: "remove", path: `/relations/${index}` }));
    for (const [key, relation] of desired) {
        if (!retained.has(key))
            operations.push({ op: "add", path: "/relations/-", value: relation });
    }
    return { operations, unmapped, unmappedLocal };
}
/** pm item statuses mapped to the Azure DevOps states they correspond to. */
export const STATE_MAP = {
    open: "New",
    in_progress: "Active",
    blocked: "Active",
    closed: "Closed",
};
/**
 * The maximum number of sub-requests Azure DevOps accepts in one batch call.
 *
 * Reading a project one work item at a time is the difference between a handful
 * of round trips and hundreds, which for an agent is latency and token budget
 * rather than an abstract efficiency concern.
 */
export const BATCH_LIMIT = 200;
/**
 * Split work item ids into batches the batch endpoint will accept.
 *
 * @param ids - The work item ids to fetch, in any order.
 * @returns Batches of at most {@link BATCH_LIMIT} ids, preserving input order.
 */
export function batchIds(ids) {
    const batches = [];
    for (let index = 0; index < ids.length; index += BATCH_LIMIT) {
        batches.push(ids.slice(index, index + BATCH_LIMIT));
    }
    return batches;
}
/**
 * Read a same-organization work item id out of a relation's REST URL.
 *
 * A numeric final segment alone is unsafe: an attachment or a foreign
 * organization's work item can use the same number as a local item. An
 * imprecise JavaScript number can also point at a different item. Only the
 * canonical work-item route under the configured organization is accepted.
 * A query or fragment, including a bare `?` or `#` that WHATWG parsing stores
 * as an empty `search` or `hash`, is not that canonical route. The raw URL
 * must also equal its serialization, rejecting parser-normalized authority
 * syntax and dot segments before they can be treated as canonical links.
 *
 * This argument is required. Callers of the published 2026.9.2 one-argument
 * form must pass `orgUrl`; omitting it throws rather than restoring unscoped
 * numeric-suffix mapping.
 *
 * @param url - The relation's `url` field.
 * @param orgUrl - The configured Azure DevOps organization URL. Required.
 * @returns The safe local work item id, or `undefined` for any other target.
 * @throws {TypeError} When `orgUrl` is omitted or not a string.
 */
export function relationTargetId(url, orgUrl) {
    if (typeof orgUrl !== "string") {
        throw new TypeError("relationTargetId requires orgUrl");
    }
    try {
        const organization = new URL(orgUrl);
        const target = new URL(url);
        const prefix = `${stripTrailingSlashes(organization.pathname)}/_apis/wit/workItems/`;
        if (url !== target.href ||
            url.includes("?") ||
            url.includes("#") ||
            target.origin !== organization.origin ||
            target.username !== "" ||
            target.password !== "" ||
            !target.pathname.startsWith(prefix))
            return undefined;
        const segment = target.pathname.slice(prefix.length);
        // Testing only the extracted segment avoids the unanchored pattern that
        // previously made long separator runs expensive.
        if (!/^[1-9][0-9]*$/u.test(segment))
            return undefined;
        const id = Number(segment);
        return Number.isSafeInteger(id) ? id : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Build the JSON Patch document for an update, led by a revision assertion.
 *
 * The `test` operation on `/rev` is the whole point: Azure DevOps evaluates it
 * before applying anything else and rejects the entire document when the
 * revision has moved, so a concurrent edit surfaces as a failure the caller can
 * retry rather than as a silent overwrite. It is emitted FIRST and
 * unconditionally — an update with no field changes still asserts, so a caller
 * cannot obtain an unchecked write by passing an empty change set.
 *
 * @param rev - The revision the local copy was read at.
 * @param fields - Field reference names mapped to their new values.
 * @param relations - Validated add/remove operations from the relation export planner.
 * @returns The patch document, beginning with the revision assertion.
 */
export function buildUpdatePatch(rev, fields, relations = []) {
    const patch = [{ op: "test", path: "/rev", value: rev }];
    for (const [name, value] of Object.entries(fields)) {
        patch.push({ op: "replace", path: `/fields/${name}`, value });
    }
    for (const operation of relations) {
        if (!(operation.op === "add" && operation.path === "/relations/-") &&
            !(operation.op === "remove" && /^\/relations\/(0|[1-9][0-9]*)$/u.test(operation.path))) {
            throw new CommandError("relation changes must add or remove relation entries");
        }
        patch.push(operation);
    }
    return patch;
}
/**
 * Report whether a patch document asserts a revision before it changes anything.
 *
 * Used as an invariant at the single write site rather than as a lint: it is
 * what makes "every write is revision-checked" a property of the code instead
 * of a promise in a comment.
 *
 * @param patch - The patch document about to be sent.
 * @returns True when the first operation tests `/rev`.
 */
export function assertsRevision(patch) {
    const first = patch[0];
    return first !== undefined && first.op === "test" && first.path === "/rev";
}
/**
 * Strip trailing slashes from a URL without a regular expression.
 *
 * `replace(/\/+$/u, "")` was flagged by CodeQL (`js/polynomial-redos`) as a
 * polynomial-time regex on a run of separators: the `+` quantifier over a
 * single character followed by the end anchor lets the engine backtrack
 * O(n²) when the string has a long run of slashes before a non-slash and
 * another run at the end — the engine tries to anchor `$` from every slash
 * position in the first run, backtracking the greedy quantifier at each one.
 *
 * Scanning backward from the end of the string is O(n) with no backtracking,
 * and the input here is a library-provided URL whose length is not bounded by
 * anything in this package. `charCodeAt` returns `NaN` for an out-of-range
 * index (including `-1` when `end` reaches `0`), and `NaN !== 0x2f`, so the
 * loop terminates without a separate `end > 0` guard.
 *
 * @param value - The string to strip trailing slashes from.
 * @returns The string with every trailing `/` removed.
 */
export function stripTrailingSlashes(value) {
    let end = value.length;
    while (value.charCodeAt(end - 1) === 0x2f)
        end--;
    return value.slice(0, end);
}
/**
 * Read the Azure DevOps configuration from the environment.
 *
 * @param env - The environment to read, normally `process.env`.
 * @returns The configuration, or `undefined` when any part is missing.
 */
export function readConfig(env) {
    const orgUrl = env.ADO_ORG_URL?.trim();
    const project = env.ADO_PROJECT?.trim();
    const token = env.ADO_TOKEN?.trim();
    if (!orgUrl || !project || !token)
        return undefined;
    return { orgUrl: stripTrailingSlashes(orgUrl), project, token };
}
/** The names of the environment variables {@link readConfig} requires. */
export const REQUIRED_ENV = ["ADO_ORG_URL", "ADO_PROJECT", "ADO_TOKEN"];
/**
 * List the required environment variables that are absent or blank.
 *
 * @param env - The environment to inspect.
 * @returns The missing variable names, in declaration order.
 */
export function missingEnv(env) {
    return REQUIRED_ENV.filter((name) => !env[name]?.trim());
}
/**
 * A minimal Azure DevOps Work Items client.
 *
 * Deliberately small: it exposes only the calls this package makes, and it
 * takes its transport as a parameter so every mapping and patch-building
 * decision is testable without a network or a recorded fixture.
 */
export class AdoClient {
    #config;
    #transport;
    /**
     * Construct a client bound to one project.
     *
     * @param config - Organisation, project and token.
     * @param transport - The request performer to use.
     */
    constructor(config, transport) {
        this.#config = config;
        this.#transport = transport;
    }
    /** The `Authorization` header value for a personal access token. */
    get #auth() {
        // Azure DevOps expects a PAT as the password of a basic credential with an
        // empty username.
        return `Basic ${Buffer.from(`:${this.#config.token}`).toString("base64")}`;
    }
    /**
     * Perform a request and decode its JSON body.
     *
     * @param method - The HTTP method.
     * @param path - Path and query below the project, e.g. `/_apis/wit/wiql`.
     * @param body - The value to send as JSON, or `undefined`.
     * @param contentType - The body media type; Azure DevOps requires
     *   `application/json-patch+json` for work item updates.
     * @returns The decoded response body.
     * @throws {CommandError} When the service reports a failure, or a revision
     *   assertion was rejected, or the body is not decodable JSON.
     */
    async request(method, path, body, contentType = "application/json") {
        const url = `${this.#config.orgUrl}/${encodeURIComponent(this.#config.project)}${path}`;
        // The invariant lives here rather than at one call site, so it guards EVERY
        // patch this client will ever send. A patch document that does not open
        // with a revision assertion is an unchecked write, and an unchecked write
        // is the failure this package exists to make impossible - so it is refused
        // before it reaches the network, whatever produced it.
        if (contentType === PATCH_MEDIA_TYPE && !(Array.isArray(body) && assertsRevision(body))) {
            throw new CommandError("refusing to send a work item patch that does not assert a revision", EXIT_CODE.usage);
        }
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const headers = { Accept: "application/json", Authorization: this.#auth };
        if (payload !== undefined)
            headers["Content-Type"] = contentType;
        const response = await this.#transport(method, url, payload, headers);
        if (response.status === 412 && method === "PATCH") {
            // Azure DevOps answers a failed `test` operation with a precondition
            // failure. That is the revision race, and it is the one remote failure a
            // caller can resolve by re-reading and replaying rather than by giving up.
            // The guard on `method` keeps a 412 arriving on a non-PATCH call (a batch
            // read, a WIQL query) classified as a transport error rather than a
            // conflict — a 412 on a GET is not a revision assertion failure.
            throw new CommandError(`the work item changed since it was read, so the update was refused (${url})`, EXIT_CODE.conflict);
        }
        if (response.status < 200 || response.status >= 300) {
            throw new CommandError(`Azure DevOps returned ${response.status} for ${method} ${url}`, EXIT_CODE.remote);
        }
        try {
            return JSON.parse(response.body);
        }
        catch {
            throw new CommandError(`Azure DevOps returned a body that is not JSON for ${method} ${url}`, EXIT_CODE.remote);
        }
    }
    /**
     * Fetch work items through the batch endpoint.
     *
     * Issues one request per {@link BATCH_LIMIT} ids rather than one per item.
     * Delegates to {@link getWorkItemsReport} and returns only the found items,
     * preserving the shape callers already depend on.
     *
     * @param ids - The work item ids to fetch.
     * @returns The work items, in the order the service returned them.
     */
    async getWorkItems(ids) {
        return (await this.getWorkItemsReport(ids)).items;
    }
    /**
     * Fetch work items through the batch endpoint, surfacing per-item failures.
     *
     * Sends `errorPolicy: "omit"` so a missing work item does not fail the batch
     * call — the service returns 200 and simply leaves the missing id out of the
     * response. The omitted ids are collected and returned as `missing` so a
     * partial batch failure is surfaced per sub-request rather than failing the
     * whole sync or silently dropping items.
     *
     * @param ids - The work item ids to fetch.
     * @returns The found items and the ids the service omitted.
     */
    async getWorkItemsReport(ids) {
        const items = [];
        const missing = [];
        for (const batch of batchIds(ids)) {
            const payload = await this.request("POST", "/_apis/wit/workitemsbatch?api-version=7.1", {
                ids: batch,
                $expand: "relations",
                errorPolicy: "omit",
            });
            const value = payload.value;
            const found = value !== undefined ? [...value] : [];
            items.push(...found);
            const foundIds = new Set(found.map((item) => item.id));
            for (const id of batch) {
                if (!foundIds.has(id))
                    missing.push(id);
            }
        }
        return { items, missing };
    }
    /**
     * Run a WIQL query and return the work item ids it selects.
     *
     * @param wiql - The query text.
     * @returns The selected work item ids.
     */
    async queryIds(wiql) {
        const payload = await this.request("POST", "/_apis/wit/wiql?api-version=7.1", { query: wiql });
        const rows = payload.workItems ?? [];
        return rows.flatMap((row) => (typeof row.id === "number" ? [row.id] : []));
    }
    /**
     * Update a work item, asserting the revision it was read at.
     *
     * This is the only write path in the package, and it refuses to send a patch
     * that does not assert a revision. Making that a guard rather than a
     * convention is what keeps "no unchecked writes" true as the package grows.
     *
     * When the asserted revision is stale the service returns 412 and the update
     * is rejected in its entirety — nothing is mutated. A single diagnostic
     * re-read then establishes the revision the item is actually at, and the
     * conflict is surfaced as a typed error naming the item and both revisions —
     * the one the caller read at and the one the service is now at.
     *
     * The stale write is deliberately **not** replayed onto the newer revision.
     * Replaying would write the caller's field values over a change it never
     * read, which is the silent overwrite this assertion exists to prevent. Only
     * the caller can decide what its change means against the newer state, so the
     * conflict is returned to it rather than resolved on its behalf.
     *
     * @param id - The work item id.
     * @param rev - The revision the local copy was read at.
     * @param fields - Field reference names mapped to their new values.
     * @param relations - Relation add/remove operations to apply in the same revision check.
     * @returns The updated work item as the service returned it.
     * @throws {CommandError} With {@link EXIT_CODE.conflict} when the revision
     *   moved, naming the item and both revisions.
     */
    async updateWorkItem(id, rev, fields, relations = []) {
        try {
            const patch = buildUpdatePatch(rev, fields, relations);
            const payload = await this.request("PATCH", `/_apis/wit/workitems/${id}?api-version=7.1`, patch, PATCH_MEDIA_TYPE);
            return payload;
        }
        catch (error) {
            if (!(error instanceof CommandError) || error.exitCode !== EXIT_CODE.conflict) {
                throw error;
            }
            // Re-read purely to make the conflict actionable: the caller learns which
            // revision it asserted and which revision the item is actually at. This
            // deliberately does NOT replay the write onto the new revision. Replaying
            // would resolve the 412 by writing the same field values over a change
            // this caller never read, which is precisely the silent overwrite the
            // revision assertion exists to prevent. The caller re-reads, decides what
            // its change means against the newer state, and writes again.
            const [current] = await this.getWorkItems([id]);
            throw new CommandError(`work item ${id} changed since it was read: asserted rev ${rev}` +
                (current !== undefined ? ` but current rev is ${current.rev}` : " and could not be re-read"), EXIT_CODE.conflict);
        }
    }
}
/**
 * Translate a work item's relations into pm links.
 *
 * Unmapped relation kinds are reported rather than dropped: an attachment or a
 * remote-work-item link is a real edge that this package simply does not model,
 * and silently discarding it would make an import look complete when it is not.
 *
 * @param item - The work item whose relations to translate.
 * @param orgUrl - The organization whose work item identities may be mapped.
 *   Required. Callers of the published 2026.9.2 one-argument form must pass it;
 *   omitting it throws instead of treating every relation as unmapped.
 * @param custom - Explicit custom reference-name mappings; built-in names cannot be overridden.
 * @returns The recognised links, and the relation names that were not mapped.
 * @throws {TypeError} When `orgUrl` is omitted or not a string.
 */
export function mapRelations(item, orgUrl, custom = {}) {
    if (typeof orgUrl !== "string") {
        throw new TypeError("mapRelations requires orgUrl");
    }
    const links = [];
    const unmapped = [];
    const seen = new Set();
    for (const relation of item.relations ?? []) {
        const kind = relationKind(relation.rel, custom);
        const targetId = relationTargetId(relation.url, orgUrl);
        if (kind === undefined || targetId === undefined) {
            unmapped.push(relation.rel);
            continue;
        }
        const key = `${relation.rel}:${targetId}`;
        if (!seen.has(key))
            links.push({ kind, targetId });
        seen.add(key);
    }
    return { links, unmapped };
}
/** Command paths that reach Azure DevOps and therefore need credentials. */
export const MUTATING_COMMANDS = ["ado sync", "ado import", "ado export"];
/**
 * Decide whether a preflight should abort for want of credentials.
 *
 * Offline diagnostics (`ado validate`) and dry runs are explicitly exempt: they
 * exist to be usable when the credentials are exactly what is missing.
 *
 * @param command - The command path pm is about to run.
 * @param options - The parsed options for that command.
 * @param env - The environment to read credentials from.
 * @returns True when the command would hit the network without credentials.
 */
export function shouldFailFast(command, options, env) {
    if (!MUTATING_COMMANDS.includes(command))
        return false;
    if (options.dryRun === true)
        return false;
    return missingEnv(env).length > 0;
}
/**
 * Render the operator-facing message for a credential preflight abort.
 *
 * Names the variables that are missing and nothing about the ones that are
 * present, so the message is safe to print in CI output.
 *
 * @param command - The command that was refused.
 * @param missing - The environment variable names that are absent.
 * @returns The message to write to stderr.
 */
export function preflightMessage(command, missing) {
    return [
        `pm ${command} needs Azure DevOps credentials and ${missing.length === 1 ? "one is" : `${missing.length} are`} missing: ${missing.join(", ")}.`,
        "",
        "Set them and re-run:",
        "  export ADO_ORG_URL=https://dev.azure.com/<org>",
        "  export ADO_PROJECT=<project>",
        "  export ADO_TOKEN=<personal access token with Work Items read and write>",
        "",
        "To check readiness without a network call: pm ado validate",
    ].join("\n");
}
/**
 * Decide and act on the credential preflight for one invocation.
 *
 * Extracted from the registration so both paths are exercisable: the refusal
 * ends the process, and a callback that calls `process.exit` directly cannot be
 * tested in-process without taking the test runner down with it. The writer and
 * the exit are parameters for that reason, not for configurability.
 *
 * The refusal terminates rather than throws because pm's preflight runtime
 * wraps this callback in a try/catch that turns a throw into a non-fatal
 * warning and lets the command proceed - so a throw here could not fail fast.
 *
 * @param ctx - The preflight context pm supplies.
 * @param env - The environment to read credentials from.
 * @param write - Sink for the operator-facing message.
 * @param exit - Process terminator, called with a usage exit code.
 * @returns An empty decision delta when the command may proceed.
 */
export function runCredentialPreflight(ctx, env, write, exit) {
    const command = ctx?.command ?? "";
    const options = ctx?.options ?? {};
    if (shouldFailFast(command, options, env)) {
        write(`${preflightMessage(command, missingEnv(env))}\n`);
        exit(EXIT_CODE.usage);
    }
    return {};
}
/**
 * Local stand-in for the SDK's `defineExtension` identity helper.
 *
 * Declared here rather than imported so this package keeps a type-only
 * dependency on `@unbrained/pm-cli` and adds no runtime module edge. The
 * generic constraint is the SDK's own, so the extension object is contract
 * checked against {@link ExtensionModule} exactly as the imported helper would.
 */
const defineExtension = (module) => module;
export default defineExtension({
    name: "pm-ado",
    version: "2026.9.2",
    activate(api) {
        // schema — Azure DevOps provenance, including the revision every write asserts.
        api.registerItemFields([
            { name: "ado_id", type: "number", optional: true },
            { name: "ado_url", type: "string", optional: true },
            { name: "ado_rev", type: "number", optional: true },
            { name: "ado_project", type: "string", optional: true },
        ]);
        // preflight — abort a network-bound command before any store read or remote
        // call when credentials are absent. Scoped to this package's own command
        // paths: an unscoped override collides pairwise with every other installed
        // package's override, which pm health reports as
        // extension_preflight_override_collision.
        //
        // The runtime wraps this callback in a try/catch that turns a throw into a
        // non-fatal warning and lets the command proceed, so a bare `throw` here
        // cannot fail fast. Writing the message and exiting bypasses that catch.
        api.registerPreflight({
            commands: [...MUTATING_COMMANDS],
            run: (ctx) => runCredentialPreflight(ctx, process.env, process.stderr.write.bind(process.stderr), process.exit.bind(process)),
        });
        api.registerCommand({
            name: "ado validate",
            description: "Check Azure DevOps readiness without making a network call",
            intent: "Diagnose whether pm-ado has the configuration it needs, without leaking secrets",
            examples: ["pm ado validate"],
            handler: (_ctx) => {
                const missing = missingEnv(process.env);
                const config = readConfig(process.env);
                return {
                    ok: missing.length === 0,
                    // Never the token: only whether it is present, and where it points.
                    org_url: config?.orgUrl ?? null,
                    project: config?.project ?? null,
                    token_present: process.env.ADO_TOKEN !== undefined && process.env.ADO_TOKEN.trim() !== "",
                    missing,
                    batch_limit: BATCH_LIMIT,
                    writes_assert_revision: true,
                };
            },
        });
    },
});
//# sourceMappingURL=index.js.map