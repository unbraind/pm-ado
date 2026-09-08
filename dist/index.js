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
    "System.LinkTypes.Dependency-Reverse": "blocked_by",
    "System.LinkTypes.Dependency-Forward": "blocks",
};
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
 * Read the work item id out of a relation's REST URL.
 *
 * Azure DevOps identifies a relation target by URL rather than by id, so the id
 * has to be recovered from the final path segment. A URL whose last segment is
 * not a positive integer is not a work item link (an attachment or an external
 * hyperlink, say) and yields `undefined` rather than `NaN`.
 *
 * @param url - The relation's `url` field.
 * @returns The target work item id, or `undefined` when the URL names no item.
 */
export function relationTargetId(url) {
    // `lastIndexOf` rather than `split`, because `split(...).pop()` is typed as
    // possibly-undefined for a case that cannot happen, and guarding it would add
    // a branch no test can reach. Both outcomes here ARE reachable: a URL with no
    // separator is just its own final segment.
    //
    // The scan is deliberately not part of the pattern. Searching for the segment
    // with an unanchored expression made this quadratic on a run of separators -
    // CodeQL flagged exactly that. Anchoring the test to an already-extracted
    // segment leaves nothing to backtrack over.
    const separator = url.lastIndexOf("/");
    const segment = separator === -1 ? url : url.slice(separator + 1);
    return /^[1-9][0-9]*$/u.test(segment) ? Number(segment) : undefined;
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
 * @returns The patch document, beginning with the revision assertion.
 */
export function buildUpdatePatch(rev, fields) {
    const patch = [{ op: "test", path: "/rev", value: rev }];
    for (const [name, value] of Object.entries(fields)) {
        patch.push({ op: "replace", path: `/fields/${name}`, value });
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
     * @returns The updated work item as the service returned it.
     * @throws {CommandError} With {@link EXIT_CODE.conflict} when the revision
     *   moved, naming the item and both revisions.
     */
    async updateWorkItem(id, rev, fields) {
        try {
            const patch = buildUpdatePatch(rev, fields);
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
 * @returns The recognised links, and the relation names that were not mapped.
 */
export function mapRelations(item) {
    const links = [];
    const unmapped = [];
    for (const relation of item.relations ?? []) {
        const kind = RELATION_MAP[relation.rel];
        const targetId = relationTargetId(relation.url);
        if (kind === undefined || targetId === undefined) {
            unmapped.push(relation.rel);
            continue;
        }
        links.push({ kind, targetId });
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