import type { ExtensionApi, PreflightOverrideContext } from "@unbrained/pm-cli/sdk/authoring";
/**
 * Semantic exit codes pm's command runtime propagates to the shell.
 *
 * Mirrored here rather than imported because a standalone-installed extension
 * loads only its own `dist/`, so `@unbrained/pm-cli` is not resolvable at
 * runtime. {@link CommandError} carries one of these so a handled failure exits
 * cleanly once instead of re-invoking the handler.
 */
export declare const EXIT_CODE: {
    /** The invocation was malformed or missing required configuration. */
    readonly usage: 2;
    /** A remote call failed, or the service returned an unusable response. */
    readonly remote: 3;
    /** A write lost a revision race and the caller must re-read and retry. */
    readonly conflict: 4;
};
/**
 * An error carrying the exit code pm's runtime should exit with.
 *
 * pm treats a thrown error as a cleanly handled non-zero exit only when it
 * carries a numeric `exitCode`; a plain `Error` makes the runtime fall through
 * to its unhandled path, which re-invokes the handler and doubles any side
 * effect already performed.
 */
export declare class CommandError extends Error {
    /** The exit code pm's command runtime should terminate with. */
    readonly exitCode: number;
    /**
     * Construct a handled command failure.
     *
     * @param message - Operator-facing description of what went wrong.
     * @param exitCode - One of {@link EXIT_CODE}; defaults to a usage failure.
     */
    constructor(message: string, exitCode?: number);
}
/** The media type Azure DevOps requires for a work item patch document. */
export declare const PATCH_MEDIA_TYPE = "application/json-patch+json";
/** One operation in an Azure DevOps JSON Patch document. */
export interface JsonPatchOperation {
    /** The patch verb. `test` asserts a value without changing it. */
    op: "add" | "replace" | "remove" | "test";
    /** JSON Pointer to the target, e.g. `/fields/System.Title`. */
    path: string;
    /** The value to write, or to assert when `op` is `test`. */
    value?: unknown;
}
/** The subset of an Azure DevOps work item this package reads. */
export interface AdoWorkItem {
    /** The work item's numeric id, unique within the organisation. */
    id: number;
    /** The monotonically increasing revision, incremented by every update. */
    rev: number;
    /** The work item's field bag, keyed by reference name. */
    fields: Record<string, unknown>;
    /** Typed links to other work items, when the read requested them. */
    relations?: readonly AdoRelation[];
}
/**
 * The outcome of a batch read: items the service returned and ids it omitted.
 *
 * With `errorPolicy: "omit"` a missing work item does not fail the batch call;
 * the service simply leaves it out of the response. Surfacing the omitted
 * ids per sub-request — rather than failing the whole sync or silently
 * dropping them — is what makes a partial batch failure actionable.
 */
export interface BatchReadResult {
    /** Work items the service returned, in the order the service returned them. */
    items: AdoWorkItem[];
    /** Requested ids the service omitted, in the order they were requested. */
    missing: number[];
}
/** A typed link from one work item to another, or to a URL. */
export interface AdoRelation {
    /** The Azure DevOps relation reference name, e.g. `System.LinkTypes.Hierarchy-Reverse`. */
    rel: string;
    /** The target's REST URL; its final path segment is the work item id. */
    url: string;
}
/**
 * Azure DevOps relation reference names mapped to the pm concepts they mean.
 *
 * Azure DevOps relations are typed rather than free-form, which is why they can
 * be mapped at all: each name already carries the meaning pm expresses as a
 * parent link or a dependency kind. `Hierarchy-Reverse` points at the PARENT
 * (the reverse end of a parent-to-child link), which is the direction most
 * often got backwards.
 */
export declare const RELATION_MAP: Readonly<Record<string, "parent" | "child" | "related" | "duplicate" | "blocked_by" | "blocks">>;
/** pm item statuses mapped to the Azure DevOps states they correspond to. */
export declare const STATE_MAP: Readonly<Record<string, string>>;
/**
 * The maximum number of sub-requests Azure DevOps accepts in one batch call.
 *
 * Reading a project one work item at a time is the difference between a handful
 * of round trips and hundreds, which for an agent is latency and token budget
 * rather than an abstract efficiency concern.
 */
export declare const BATCH_LIMIT = 200;
/**
 * Split work item ids into batches the batch endpoint will accept.
 *
 * @param ids - The work item ids to fetch, in any order.
 * @returns Batches of at most {@link BATCH_LIMIT} ids, preserving input order.
 */
export declare function batchIds(ids: readonly number[]): number[][];
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
export declare function relationTargetId(url: string): number | undefined;
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
export declare function buildUpdatePatch(rev: number, fields: Readonly<Record<string, unknown>>): JsonPatchOperation[];
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
export declare function assertsRevision(patch: readonly JsonPatchOperation[]): boolean;
/** Credentials and target coordinates for one Azure DevOps project. */
export interface AdoConfig {
    /** Organisation URL, e.g. `https://dev.azure.com/contoso`. */
    orgUrl: string;
    /** The project name or id. */
    project: string;
    /** A personal access token with Work Items read and write. */
    token: string;
}
/** The transport a client uses, injectable so the mapping can be tested offline. */
export interface AdoTransport {
    /**
     * Perform one HTTPS request against the Azure DevOps REST API.
     *
     * @param method - The HTTP method.
     * @param url - The absolute request URL.
     * @param body - The request body, already serialised, or `undefined`.
     * @param headers - Request headers, including the authorization credential.
     * @returns The response status and decoded body.
     */
    (method: string, url: string, body: string | undefined, headers: Readonly<Record<string, string>>): Promise<{
        status: number;
        body: string;
    }>;
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
export declare function stripTrailingSlashes(value: string): string;
/**
 * Read the Azure DevOps configuration from the environment.
 *
 * @param env - The environment to read, normally `process.env`.
 * @returns The configuration, or `undefined` when any part is missing.
 */
export declare function readConfig(env: Readonly<Record<string, string | undefined>>): AdoConfig | undefined;
/** The names of the environment variables {@link readConfig} requires. */
export declare const REQUIRED_ENV: readonly ["ADO_ORG_URL", "ADO_PROJECT", "ADO_TOKEN"];
/**
 * List the required environment variables that are absent or blank.
 *
 * @param env - The environment to inspect.
 * @returns The missing variable names, in declaration order.
 */
export declare function missingEnv(env: Readonly<Record<string, string | undefined>>): string[];
/**
 * A minimal Azure DevOps Work Items client.
 *
 * Deliberately small: it exposes only the calls this package makes, and it
 * takes its transport as a parameter so every mapping and patch-building
 * decision is testable without a network or a recorded fixture.
 */
export declare class AdoClient {
    #private;
    /**
     * Construct a client bound to one project.
     *
     * @param config - Organisation, project and token.
     * @param transport - The request performer to use.
     */
    constructor(config: AdoConfig, transport: AdoTransport);
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
    request(method: string, path: string, body?: unknown, contentType?: string): Promise<unknown>;
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
    getWorkItems(ids: readonly number[]): Promise<AdoWorkItem[]>;
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
    getWorkItemsReport(ids: readonly number[]): Promise<BatchReadResult>;
    /**
     * Run a WIQL query and return the work item ids it selects.
     *
     * @param wiql - The query text.
     * @returns The selected work item ids.
     */
    queryIds(wiql: string): Promise<number[]>;
    /**
     * Update a work item, asserting the revision it was read at.
     *
     * This is the only write path in the package, and it refuses to send a patch
     * that does not assert a revision. Making that a guard rather than a
     * convention is what keeps "no unchecked writes" true as the package grows.
     *
     * When the asserted revision is stale the service returns 412 and the update
     * is rejected in its entirety — nothing is mutated. Rather than surfacing that
     * as a dead-end failure, a bounded retry re-reads the work item, replays the
     * intended field changes onto the new revision, and asserts again. If the
     * retry also loses the race (or the item cannot be re-read) the conflict is
     * surfaced as a typed, actionable error naming the item and both revisions
     * — the one the caller read at and the one the service is now at — so a
     * concurrent agent's change is never silently overwritten.
     *
     * @param id - The work item id.
     * @param rev - The revision the local copy was read at.
     * @param fields - Field reference names mapped to their new values.
     * @param maxRetries - Maximum number of re-read-and-retry attempts before
     *   surfacing the conflict. Defaults to 1.
     * @returns The updated work item as the service returned it.
     * @throws {CommandError} With {@link EXIT_CODE.conflict} when the revision
     *   moved and retries are exhausted, naming the item and both revisions.
     */
    updateWorkItem(id: number, rev: number, fields: Readonly<Record<string, unknown>>, maxRetries?: number): Promise<AdoWorkItem>;
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
export declare function mapRelations(item: AdoWorkItem): {
    links: {
        kind: string;
        targetId: number;
    }[];
    unmapped: string[];
};
/** Command paths that reach Azure DevOps and therefore need credentials. */
export declare const MUTATING_COMMANDS: readonly string[];
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
export declare function shouldFailFast(command: string, options: Readonly<Record<string, unknown>>, env: Readonly<Record<string, string | undefined>>): boolean;
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
export declare function preflightMessage(command: string, missing: readonly string[]): string;
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
export declare function runCredentialPreflight(ctx: PreflightOverrideContext, env: Readonly<Record<string, string | undefined>>, write: (message: string) => unknown, exit: (code: number) => never): Record<string, never>;
declare const _default: {
    name: string;
    version: string;
    activate(api: ExtensionApi): void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map