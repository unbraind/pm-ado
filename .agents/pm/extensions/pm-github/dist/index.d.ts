import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import { type BulkItemMutation, type CommitItemMutationsOptions, type CommitItemMutationsResult, type ItemDocument } from "@unbrained/pm-cli/sdk";
/**
 * One GitHub issue or pull request as returned by the REST issues endpoint.
 *
 * The REST issues endpoint lists PRs alongside issues (a PR is an issue that
 * also carries a `pull_request` object); {@link isDraftPr} and the
 * `includePrs` / `skipDrafts` filters decide which of those survive into an
 * import.
 */
export interface GhIssue {
    /** Issue/PR number within its repo (the `N` in `gh:owner/repo#N` provenance). */
    number: number;
    /** One-line issue title, imported as the pm item title. */
    title: string;
    /** Markdown body, imported as the pm item body (`null` when GitHub stored none). */
    body: string | null;
    /** GitHub lifecycle state; mapped to a pm status by {@link mapState}. */
    state: "open" | "closed";
    /** Why a closed issue was closed; `not_planned` maps to `canceled`, not `closed`. */
    state_reason?: "completed" | "not_planned" | "reopened" | null;
    /** Labels on the issue, imported verbatim as pm tags (before any `--label-map`). */
    labels: Array<{
        name: string;
    }>;
    /** Author login, surfaced as a `github_author:` tag when present. */
    user?: {
        login: string;
    } | null;
    /** Assigned user, or `null` (imported as the item assignee when set). */
    assignee: {
        login: string;
    } | null;
    /** Milestone title, or `null` (filtered client-side by `--milestone`). */
    milestone: {
        title: string;
    } | null;
    /** ISO 8601 creation timestamp. */
    created_at: string;
    /** ISO 8601 last-update timestamp, used by the `--since` incremental filter. */
    updated_at: string;
    /** GitHub completion timestamp (`null` while the issue is open); carried as `--completed-at` on close. */
    closed_at?: string | null;
    /** Browser URL of the issue, embedded in the imported description. */
    html_url: string;
    /** Comment count GitHub reports; drives whether comments are fetched at all. */
    comments?: number;
    /** REST URL of the issue's comments collection (paginated when present). */
    comments_url?: string;
    /** Present (opaque) when the issue is actually a pull request; its presence is the PR signal. */
    pull_request?: unknown;
    /** `true` when the issue is a draft pull request (GitHub sets this only on draft PRs). */
    draft?: boolean;
}
export interface GhComment {
    id: number;
    user: {
        login: string;
    } | null;
    created_at: string;
    body: string | null;
}
type CommentsMode = "body" | "annotations" | "both";
/**
 * Normalized options governing one GitHub issue import.
 *
 * Produced by {@link parseImportOptions} from the raw CLI flag bag so the rest
 * of the import path consumes a typed shape rather than re-parsing strings.
 */
export interface ImportOptions {
    /** GitHub issue state to fetch: `open`, `closed`, or `all`. */
    state: "open" | "closed" | "all";
    /** Comma-separated label filter applied server-side. */
    labels?: string;
    /** ISO timestamp; only issues updated after it are fetched (server-side). */
    since?: string;
    /** Assignee login filter applied server-side. */
    assignee?: string;
    /** Milestone title filter applied client-side (the API keys milestones by number, not title). */
    milestone?: string;
    /** Whether pull requests are included (filtered out by default). */
    includePrs: boolean;
    /** Whether draft pull requests are excluded (only meaningful with {@link includePrs}). */
    skipDrafts: boolean;
    /** Whether fetched comments are also embedded in the item body (legacy behavior). */
    withComments: boolean;
    /** How fetched comments are persisted: body, native annotations, or both. */
    commentsMode: CommentsMode;
    /** pm item type assigned to every created item (default `Issue`). */
    itemType: string;
    /** When true, preview the plan without writing to the tracker or GitHub. */
    dryRun: boolean;
    /** When true, commit the batch as one crash-resumable SDK transaction. */
    atomic: boolean;
    /** When true, run the `--link-deps` dependency-edge second pass after import. */
    linkDeps: boolean;
}
type CommitItemMutations = (options: CommitItemMutationsOptions) => Promise<CommitItemMutationsResult>;
type NormalizeItemId = (input: string, prefix: string) => string;
type ReadSettings = (pmRoot: string) => Promise<{
    id_prefix?: string;
}>;
/**
 * Injectable collaborators for the atomic import path.
 *
 * Lets the crash-resumable transaction be exercised hermetically against fake
 * SDK functions. Every member is optional because production wires the real SDK
 * defaults; a test overrides only the ones it needs.
 */
export interface AtomicImportOptions {
    /** Author identity stamped onto the transaction's mutations (default `pm-github`). */
    atomicAuthor?: string;
    /** SDK bulk-mutation primitive that applies and journals the transaction. */
    commitItemMutations?: CommitItemMutations;
    /** SDK id normalizer that derives each item's stable external-key id. */
    normalizeItemId?: NormalizeItemId;
    /** SDK settings reader used to resolve the workspace's id prefix. */
    readSettings?: ReadSettings;
}
export interface ImportRunDependencies {
    resolveToken?: () => string | undefined;
    fetchIssues?: (repo: string, opts: ImportOptions, token?: string) => Promise<GhIssue[]>;
    fetchIssueComments?: (issue: GhIssue, repo: string, token?: string) => Promise<GhComment[]>;
    readItems?: (pmRoot: string) => PmItem[];
    commitAtomic?: typeof importGithubAtomic;
    /** Snapshot workspace item metadata for the ordering-cycle advisory. Defaults to the SDK `listAllItemMetadata`. */
    listItemMetadata?: (pmRoot: string) => Promise<DepLinkSnapshotItem[]>;
    /** Warnings for ordering cycles a mutation newly introduced. Defaults to the SDK `collectNewOrderingCycleWarnings`. */
    collectOrderingCycleWarnings?: (before: readonly DepLinkSnapshotItem[], after: readonly DepLinkSnapshotItem[], changedItemId: string) => string[];
    /** Apply one resolved dependency edge. Defaults to spawning `pm update --dep`. */
    applyDependencyLink?: (edge: ResolvedDepEdge, pmRoot: string) => {
        ok: boolean;
        stderr: string;
    };
}
export declare function resolveGitHubToken(): string | undefined;
/**
 * Decide whether the Authorization token may be forwarded across a redirect.
 *
 * Only same-origin (scheme + host + port) redirects keep the credential; any
 * origin change drops it so the bearer token can never leak to a third party.
 *
 * @param fromUrl - The URL the redirect originated from.
 * @param toUrl - The redirect target URL.
 * @returns True when both URLs share an origin.
 */
export declare function sameOrigin(fromUrl: string, toUrl: string): boolean;
/**
 * Compute how long (ms) to wait before retrying a rate-limited or transient
 * response.
 *
 * Honors `Retry-After` (seconds) and the primary rate-limit reset window
 * (`X-RateLimit-Remaining: 0` + `X-RateLimit-Reset` epoch), then falls back to
 * exponential backoff. The result is capped so a CLI run is never hung
 * indefinitely.
 *
 * @param headers - Response headers to read the retry hints from.
 * @param attempt - Zero-based retry index feeding the exponential backoff floor.
 * @param nowMs - Current epoch ms, used to measure the reset window's remaining time.
 * @returns The capped wait in milliseconds.
 */
export declare function computeBackoffMs(headers: Record<string, string | string[] | undefined>, attempt: number, nowMs?: number): number;
/**
 * Structured view of GitHub's rate-limit headers off one response.
 *
 * Fields are `undefined` when the corresponding header is absent or non-numeric
 * so callers can degrade gracefully; `reset` is the epoch-second timestamp at
 * which the current window reopens.
 */
export interface RateLimitInfo {
    /** Remaining requests in the current window. */
    remaining?: number;
    /** Total requests permitted per window. */
    limit?: number;
    /** Epoch seconds at which the window resets. */
    reset?: number;
    /** True when the remaining quota is at/under the low-water mark. */
    low: boolean;
}
export declare function parseRateLimit(headers: Record<string, string | string[] | undefined>, lowThreshold?: number): RateLimitInfo;
export declare function formatRateLimit(info: RateLimitInfo): string | undefined;
export declare function parseNextLink(linkHeader?: string): string | undefined;
export declare function mapState(state: string, stateReason?: string | null): string;
export declare function optionEnabled(options: Record<string, unknown>, ...keys: string[]): boolean;
export declare function optionString(options: Record<string, unknown>, ...keys: string[]): string | undefined;
export declare function optionProvided(options: Record<string, unknown>, ...keys: string[]): boolean;
export declare function parseSince(value: string | undefined, nowMs?: number): string | undefined;
export declare function parseLabelMap(options: Record<string, unknown>, ...keys: string[]): Map<string, string> | undefined;
export declare function applyLabelMap(labels: string[], labelMap: Map<string, string> | undefined): string[];
export declare function optionCsv(options: Record<string, unknown>, ...keys: string[]): string[];
export declare const EXIT_CODE: {
    readonly GENERIC_FAILURE: 1;
    readonly USAGE: 2;
    readonly NOT_FOUND: 3;
};
/**
 * Error that carries a semantic process exit code.
 *
 * pm's command runtime treats a thrown error as a cleanly handled non-zero exit
 * only when it exposes a numeric `exitCode`; a plain `Error` instead falls
 * through to the "unhandled" path, which re-invokes the handler (doubling side
 * effects such as a second GitHub fetch) and exits with a generic code. Throwing
 * this routes a failure to a clean, single exit at the chosen code.
 */
export declare class CommandError extends Error {
    /** Numeric exit code the runtime propagates to the shell (one of {@link EXIT_CODE}). */
    exitCode: number;
    constructor(message: string, exitCode?: number);
}
/**
 * Build the `gh:owner/repo#N` provenance tag linking a pm item to a GitHub issue.
 *
 * The tag is the idempotency key: it round-trips losslessly through
 * `pm create --tags` / `pm list --json`, so a re-import can find the existing
 * item and UPDATE it instead of duplicating. Provenance also rides on declared
 * schema fields and the description, but the tag is what matching keys on.
 *
 * @param repo - `owner/repo`, lowercased into the tag.
 * @param issueNumber - The issue/PR number.
 * @returns The provenance tag string.
 */
export declare function provenanceTag(repo: string, issueNumber: number): string;
/**
 * Parse a `gh:owner/repo#N` provenance tag back into its repo and issue number.
 *
 * Returns `undefined` for anything that is not a provenance tag, so a caller
 * scanning a tag list can skip foreign tags without a try/catch.
 *
 * @param tag - The candidate tag string.
 * @returns The parsed repo (lowercased) and number, or `undefined`.
 */
export declare function parseProvenanceTag(tag: string): {
    repo: string;
    number: number;
} | undefined;
/**
 * Build the `github_author:login` tag recording who opened a GitHub issue.
 *
 * Mirrors how provenance rides on tags so the author survives a round-trip.
 * Returns `undefined` when the API supplied no usable login, so an empty tag is
 * never emitted.
 *
 * @param issue - The issue whose author to tag.
 * @returns The author tag, or `undefined`.
 */
export declare function authorTag(issue: GhIssue): string | undefined;
/**
 * The slice of a pm item this package reads and writes.
 *
 * A deliberately loose projection of the full tracker item: only the fields the
 * import / export / sync paths touch, so JSON from `pm list --all` parses without
 * depending on every SDK field.
 */
export interface PmItem {
    /** Stable item id (absent for items not yet created). */
    id?: string;
    /** One-line title. */
    title?: string;
    /** Lifecycle status (`open`, `in_progress`, `closed`, `canceled`, …). */
    status?: string;
    /** Long-form markdown body. */
    body?: string;
    /** Short summary shown in listings. */
    description?: string;
    /** Tag set, carrying provenance and labels. */
    tags?: string[];
}
export interface ItemScopeResult<TItem> {
    selected: TItem[];
    missing: string[];
}
export declare function scopeItemsByIds<TItem extends {
    id?: string;
}>(items: TItem[], ids: string[] | undefined): ItemScopeResult<TItem>;
/**
 * Narrow one runtime search document to a {@link PmItem}.
 *
 * The SDK declares `SearchProviderQueryContext.documents` as `ItemDocument[]`
 * with a REQUIRED `metadata`, but the runtime also hands raw pm items straight
 * through on some paths — `SearchProviderQueryContext` carries an
 * `[key: string]: unknown` index signature, so its shape is looser than the
 * declared type. Trusting `d.metadata` unconditionally therefore yields
 * `undefined` entries and crashes `indexByProvenance` with a TypeError; the
 * pre-typing code guarded this with `d?.metadata ? d.metadata : d`, and that
 * guard is preserved here rather than dropped in the name of the declared type.
 * Anything matching neither shape is skipped instead of poisoning the index.
 */
export declare function searchDocumentToItem(document: ItemDocument | PmItem | null | undefined): PmItem | undefined;
/**
 * Resolve the corpus the search provider matches remote hits against.
 *
 * Prefers the runtime-provided documents (already the current corpus) and falls
 * back to a fresh workspace read when absent. This is the provider's REAL mapping,
 * extracted so it is directly testable: the surrounding `query` handler performs
 * network I/O first, so an end-to-end test cannot reach the mapping without
 * stubbing internals, and an inline expression would be untestable in practice.
 */
export declare function resolveSearchCorpus(documents: unknown, pmRootValue: unknown): PmItem[];
/**
 * Index complete pm items by their normalized GitHub issue provenance.
 *
 * Items without a stable local id or a valid `gh:owner/repo#N` tag are skipped.
 * When legacy data contains duplicate provenance, the last corpus row wins;
 * the complete reader prevents duplicate local item ids separately.
 *
 * @param items - Complete runtime-validated pm item corpus.
 * @returns Map keyed by lowercase `owner/repo#N` provenance.
 */
export declare function indexByProvenance(items: PmItem[]): Map<string, PmItem>;
/** Fully rendered desired state for one GitHub issue import. */
export interface PreparedGithubImport {
    issueNumber: number;
    title: string;
    itemType: string;
    status: string;
    description: string;
    body: string;
    tags: string[];
    assignee?: string;
    milestone?: string;
    comments: GhComment[];
    syncAnnotations: boolean;
    /** Source completion timestamp (GitHub `closed_at`), forwarded as `--completed-at` when the item is closed. */
    closedAt?: string;
    match?: PmItem;
}
/** Minimal shape of the SDK module the atomic import path reads. */
interface AtomicSdkModule {
    commitItemMutations?: CommitItemMutations;
}
/** Resolve the atomic bulk-mutation helper. Accepts an optional SDK override for
 * tests that simulate a missing export; the default path uses the top-level
 * imported `commitItemMutations` so normal imports never touch the dynamic
 * loader. */
export declare function resolveCommitItemMutations(importSdk?: () => Promise<AtomicSdkModule>): Promise<CommitItemMutations>;
/**
 * Derive an order-independent transaction id from the desired import state and
 * exact ordered mutation plan. Content or target changes produce a fresh
 * transaction; a reordered retry of the same plan resumes the durable journal.
 */
export declare function deriveAtomicTransactionId(repo: string, entries: readonly PreparedGithubImport[], mutations: readonly BulkItemMutation[]): string;
/** Stable create id keyed by the external GitHub issue, never by fetch order. */
export declare function deriveAtomicItemId(repo: string, issueNumber: number, idPrefix: string, normalizeItemId: (input: string, prefix: string) => string): string;
/** Map one rendered import entry to its reversible SDK mutation sequence. */
export declare function buildAtomicImportMutations(repo: string, entry: PreparedGithubImport, idPrefix: string, normalizeItemId: (input: string, prefix: string) => string): {
    itemId: string;
    mutations: BulkItemMutation[];
};
/** Commit a complete issue-import batch under one crash-resumable transaction. */
export declare function importGithubAtomic(pmRoot: string, repo: string, entries: readonly PreparedGithubImport[], opts?: AtomicImportOptions): Promise<{
    transactionId: string;
    recovered: boolean;
    imported: number;
    updated: number;
    recoveredItems?: number;
    itemIds: Map<number, string>;
}>;
export declare function buildIssuesUrl(repo: string, opts: ImportOptions): string;
export declare function composeBody(issue: GhIssue, comments: GhComment[]): string;
export declare const IMPORT_LOCK_TTL_MS_DEFAULT: number;
/** Default total budget a caller waits to acquire a contended comment-sync lock before giving up and skipping that item's sync. */
export declare const IMPORT_LOCK_WAIT_MS_DEFAULT = 30000;
/**
 * Payload JSON written into a comment-sync lock file.
 *
 * Mirrors the pm CLI's own lock payload so the CLI's `pm gc` lock sweep (which
 * reads `ttl_seconds`) treats these locks exactly like its own.
 */
export interface ImportLockPayload {
    /** Lock identity (the lock file's basename without `.lock`). */
    id: string;
    /** OS process id of the holder, used to detect a dead owner. */
    pid: number;
    /** Human-readable holder label (always `pm-github`). */
    owner: string;
    /** Unique per acquisition; release() only unlinks a file carrying it. */
    token: string;
    /** ISO timestamp recorded at acquisition, the staleness age base. */
    created_at: string;
    /** Lock lifetime in seconds, read by `pm gc` to sweep abandoned locks. */
    ttl_seconds: number;
}
export interface ImportLock {
    /** Absolute path of the held lock file (diagnostics/tests). */
    path: string;
    /** Release the lock. Best-effort, idempotent, never throws. */
    release(): void;
}
export type ImportLockAcquisition = {
    status: "acquired";
    lock: ImportLock;
} | {
    status: "contended";
} | {
    status: "degraded";
};
/**
 * Resolve the pm data dir from the `pmRoot` a command handler receives.
 *
 * The host may hand either the workspace root (the dir containing `.agents/pm`)
 * or the data dir itself — the pm CLI accepts both for `--path`. This returns
 * the dir that actually holds `settings.json` and `locks/`, defaulting to
 * `pmRoot` unchanged when no nested `.agents/pm` exists.
 *
 * @param pmRoot - The path supplied by the extension host.
 * @returns The resolved pm data directory.
 */
export declare function resolvePmDataDir(pmRoot: string): string;
/**
 * Absolute lock file path for one item's comment-sync critical section.
 *
 * The item id is sanitized defensively: pm ids are already filename-safe, but
 * the lock path must never become a directory-traversal vector if that ever
 * changes.
 *
 * @param pmRoot - Workspace root or pm data dir.
 * @param itemId - The pm item id to serialize.
 * @returns Absolute path under the data dir's `locks/` directory.
 */
export declare function importCommentSyncLockPath(pmRoot: string, itemId: string): string;
/**
 * Staleness TTL for a breaker election sidecar, in ms.
 *
 * A breaker's critical section is a handful of syscalls (re-stat, re-read,
 * unlink), so a crashed breaker's sidecar goes stale in seconds, not minutes;
 * this short window lets a contender clear and re-run a dead election.
 */
export declare const IMPORT_LOCK_BREAKER_TTL_MS = 10000;
/**
 * Acquire the cross-process comment-sync lock for one item.
 *
 * Never throws: every failure mode maps to one of the three acquisition
 * statuses (`acquired`, `contended`, `degraded`) so the caller decides how to
 * degrade. `ttlMs`/`waitMs` are injectable so the wait and staleness windows
 * can be exercised without real timing in tests.
 *
 * @param pmRoot - Workspace root or pm data dir passed to {@link resolvePmDataDir}.
 * @param itemId - The pm item whose comment critical section is serialized.
 * @param opts - Optional overrides for the staleness TTL and wait budget.
 * @returns The acquisition outcome.
 */
export declare function acquireImportLock(pmRoot: string, itemId: string, opts?: {
    ttlMs?: number;
    waitMs?: number;
}): Promise<ImportLockAcquisition>;
/**
 * Matches the hidden HTML-comment marker carrying a synced GitHub comment id.
 *
 * HTML comments are invisible in rendered markdown but survive `pm comments`
 * storage verbatim, so the id embedded in the marker is the stable dedupe key.
 */
export declare const COMMENT_MARKER_REGEX: RegExp;
/**
 * Build the text for one native pm comment from a GitHub comment.
 *
 * Appends the marker so a later re-sync can de-duplicate on the GitHub comment
 * id (see {@link COMMENT_MARKER_REGEX}).
 *
 * @param comment - The GitHub comment to render.
 * @returns The comment text with the trailing id marker.
 */
export declare function buildCommentText(comment: GhComment): string;
/**
 * Collect the GitHub comment ids already synced into an item's native comments.
 *
 * Scans each stored comment's text for the stable marker. Returns the set of
 * synced ids (empty when none match, e.g. for hand-written pm comments).
 *
 * @param stored - The item's existing native comments (each may carry marker text).
 * @returns The set of already-synced GitHub comment ids.
 */
export declare function extractSyncedCommentIds(stored: {
    text?: string;
}[]): Set<number>;
/**
 * Extract the newly-created item id from `pm create --json` stdout.
 *
 * The CLI emits a FLAT envelope (`{ "id": "pm-xxxx", … }`) with no `item`
 * wrapper, so this reads `parsed.id` directly. Returns `undefined` when the
 * output genuinely cannot be parsed, so callers skip-with-warning instead of
 * crashing the whole import.
 *
 * @param stdout - Raw `pm create --json` output.
 * @returns The created item id, or `undefined`.
 */
export declare function parseCreatedItemId(stdout: string): string | undefined;
/**
 * Sync GitHub issue comments into a pm item's native comments collection.
 *
 * Idempotent: comments already present (matched by their marker id) are skipped,
 * so re-running import never duplicates. Each GitHub comment becomes one pm
 * comment authored by the GitHub login. Failures are logged and never abort the
 * import; a contended or unavailable lock degrades gracefully (see
 * {@link acquireImportLock}).
 *
 * @param itemId - The pm item to append comments to.
 * @param comments - The GitHub comments to sync.
 * @param pmRoot - Workspace root or pm data dir.
 * @param issueNumber - The source issue number (for log prefixes).
 * @returns How many comments were added and how many skipped as duplicates.
 */
export declare function syncGithubCommentsToAnnotations(itemId: string, comments: GhComment[], pmRoot: string, issueNumber: number): Promise<{
    added: number;
    skipped: number;
}>;
/**
 * Whether a GitHub issue node is a draft pull request.
 *
 * A draft PR is an issue that is BOTH a pull request and flagged `draft: true`;
 * plain issues are never drafts.
 *
 * @param issue - The issue node to test.
 * @returns True only for draft pull requests.
 */
export declare function isDraftPr(issue: GhIssue): boolean;
/**
 * Apply the client-side import filters the REST API cannot express.
 *
 * Drops pull requests (unless `includePrs`), draft PRs (when `skipDrafts`), and
 * items whose milestone title does not match (the API keys milestones by number,
 * not title). Returns the surviving issues in input order.
 *
 * @param issues - Fetched issues to narrow.
 * @param opts - Import options carrying the filter flags.
 * @returns The filtered issue list.
 */
export declare function applyClientFilters(issues: GhIssue[], opts: ImportOptions): GhIssue[];
/**
 * Normalize the raw CLI flag bag into a typed {@link ImportOptions}.
 *
 * Resolves the state filter, labels, assignee, milestone, the `--since` window,
 * PR inclusion, draft skipping, and the comment-fetching mode, throwing a
 * {@link CommandError} with a usage code on a malformed `--since` or
 * `--comments-mode`.
 *
 * @param options - The raw option object from the command handler.
 * @returns The normalized import options.
 */
export declare function parseImportOptions(options: Record<string, unknown>): ImportOptions;
/** pm dependency kinds a GitHub body reference can map to. */
export type DepRefKind = "blocked_by" | "blocks";
/** One dependency reference parsed out of an issue body. `repo` is lowercased. */
export interface ParsedDepRef {
    repo: string;
    number: number;
    kind: DepRefKind;
    /** Normalized human phrase that produced this ref ("blocked by" | "depends on" | "blocks"). */
    phrase: string;
}
/** A resolved, workspace-concrete edge ready to apply to the source pm item. */
export interface ResolvedDepEdge {
    sourceId: string;
    targetId: string;
    kind: DepRefKind;
    /** GitHub issue number of the source item (for the audit message). */
    sourceIssue: number;
    phrase: string;
}
/** Minimal item-metadata shape the link pass reads (subset of the SDK `ItemMetadata`). */
export interface DepLinkSnapshotItem {
    id: string;
    tags: string[];
    dependencies?: Array<{
        id: string;
        kind: string;
    }>;
}
/** Structured outcome of the `--link-deps` pass, merged into the import result. */
export interface DepLinkResult {
    linked: number;
    unresolved: number;
    orderingCycleWarnings: string[];
    failures: string[];
}
/**
 * Parse dependency references from one issue body. Pure. Bare `#N` refs resolve
 * against `sourceRepo` (lowercased); `owner/repo#N` refs keep their explicit
 * repo (lowercased). References are de-duplicated within the body by
 * repo+number+kind so a body repeating a link yields one ref.
 *
 * Scanning is linear: each dependency phrase is found once, then references are
 * consumed one at a time with sticky (`y`) regexes anchored at the exact scan
 * position. There is no nested quantifier or look-ahead over unbounded input,
 * so the parser cannot backtrack catastrophically on adversarial bodies.
 */
export declare function parseDependencyReferences(body: string, sourceRepo: string): ParsedDepRef[];
/** Build a `repo#number` → pm item id index from an item-metadata snapshot. */
export declare function buildProvenanceIndexFromMetadata(items: readonly DepLinkSnapshotItem[]): Map<string, string>;
/**
 * Resolve parsed references into concrete workspace edges. Skips references
 * whose source or target issue is not present in the workspace (counted as
 * `unresolved`), self-references, and duplicates. Pure.
 */
export declare function planDependencyLinks(repo: string, issues: readonly GhIssue[], provenance: ReadonlyMap<string, string>): {
    edges: ResolvedDepEdge[];
    unresolved: number;
};
/** Count candidate references across issues without resolving them (dry-run preview). */
export declare function countDependencyRefCandidates(repo: string, issues: readonly GhIssue[]): number;
/**
 * The `--link-deps` second pass. Snapshots the workspace, resolves body
 * references to edges, applies them idempotently, then re-snapshots and asks the
 * SDK which ordering cycles the batch newly introduced. Never throws for an
 * individual edge; a resolution/SDK failure surfaces through the returned
 * `failures`/warnings so the import result stays truthful.
 */
export declare function linkImportedDependencies(repo: string, issues: readonly GhIssue[], pmRoot: string, deps?: ImportRunDependencies): Promise<DepLinkResult>;
/**
 * Run the full GitHub issue import flow.
 *
 * Idempotent: items already linked (by provenance tag) to a fetched issue are
 * UPDATEd; new issues are created. Honors `--atomic` (one crash-resumable
 * transaction) versus the per-item `pm` mutation path, optional `--link-deps`,
 * and `--dry-run`. Returns a structured result and throws {@link CommandError}
 * (with a semantic exit code) on failure.
 *
 * @param repoArg - The `owner/repo` to import from.
 * @param pmRoot - Workspace root or pm data dir.
 * @param opts - Normalized import options.
 * @param deps - Injectable collaborators (token resolver, fetchers, etc.) for tests.
 */
export declare function runImport(repoArg: string | undefined, pmRoot: string, opts: ImportOptions, dependencies?: ImportRunDependencies): Promise<{
    imported: number;
    updated: number;
    skipped: number;
} | {
    transactionId: string;
    recovered: boolean;
    imported: number;
    updated: number;
    recoveredItems?: number | undefined;
    skipped: number;
    atomic: boolean;
} | {
    imported?: undefined;
    updated?: undefined;
    skipped?: undefined;
    dryRun: boolean;
    wouldImport: number;
    wouldUpdate: number;
    wouldSkip: number;
    atomic?: boolean | undefined;
    wouldLinkDependencyCandidates?: number | undefined;
}>;
/**
 * One pm → GitHub issue state-change proposed by {@link planSync}.
 *
 * `from`/`to` are GitHub issue states; the executor only PATCHes when GitHub's
 * live state disagrees with `to`.
 */
export interface SyncPlanEntry {
    /** pm item id driving the proposed change. */
    id: string;
    /** GitHub issue number to PATCH. */
    number: number;
    /** Item title, surfaced in progress output. */
    title: string;
    /** GitHub state assumed before the write (the inverse of `to`; re-checked live). */
    from: "open" | "closed";
    /** Desired GitHub state derived from the pm status. */
    to: "open" | "closed";
}
export declare function planSync(items: PmItem[], repo: string): SyncPlanEntry[];
export interface GithubExportPayload {
    title: string;
    body: string;
    labels: string[];
    state: "open" | "closed";
}
export interface ExportPlanEntry {
    id?: string;
    action: "create" | "update";
    number?: number;
    payload: GithubExportPayload;
}
export declare function buildExportPlan(items: PmItem[], repo: string | undefined, labelMap?: Map<string, string>): ExportPlanEntry[];
export declare function exportWillApply(options: Record<string, unknown>): boolean;
export interface ExportApplyFailure {
    id?: string;
    action: "create" | "update";
    number?: number;
    title: string;
    error: string;
}
export interface ExportApplyResult {
    created: number;
    updated: number;
    failed: number;
    failures: ExportApplyFailure[];
}
export type ExportRequestFn = (method: string, url: string, token: string | undefined, payload?: string) => Promise<unknown>;
/**
 * Apply an already-built export plan to GitHub, one issue at a time.
 *
 * Each create/update is isolated: a single failed write (e.g. a 422 for a label
 * that does not exist on the repo) is recorded and the loop CONTINUES with the
 * remaining items — it never abandons the rest of the batch. Pure aside from the
 * injected `requestFn`, so the per-item isolation is directly unit-testable
 * without real network I/O.
 */
export declare function applyExportPlan(plan: ExportPlanEntry[], repo: string, token: string | undefined, requestFn: ExportRequestFn): Promise<ExportApplyResult>;
/**
 * Decide the exit status of a completed `export --apply` batch.
 *
 * Per-item continuation is intentional (one bad item never aborts the batch),
 * but the batch as a whole must still report honestly: a non-empty plan that
 * wrote NOTHING while recording at least one failure is a total failure, so it
 * returns a {@link CommandError} to throw; otherwise `undefined` (exit 0).
 *
 * @param plan - The plan that was applied.
 * @param result - What the apply loop actually wrote.
 * @param repo - Target repo, included in the failure message.
 * @returns A `CommandError` to throw on total failure, else `undefined`.
 */
export declare function applyOutcomeError(plan: ExportPlanEntry[], result: ExportApplyResult, repo: string): CommandError | undefined;
/**
 * Build the GitHub Search-API URL for issues in one repo matching a free-text query.
 *
 * Restricted to `type:issue repo:<repo>` so a search never leaks across repos.
 *
 * @param repo - The `owner/repo` to search within.
 * @param query - Free-text query string.
 * @returns The encoded search URL.
 */
export declare function buildSearchUrl(repo: string, query: string): string;
/**
 * Map GitHub search result numbers to local pm-item hits.
 *
 * For every returned issue number, looks up the pm item carrying the matching
 * `gh:repo#N` provenance tag; only locally-present items become hits (the
 * runtime would drop the rest anyway). Score preserves GitHub's ranking,
 * normalized into `(0, 1]` so hits clear pm's default threshold.
 *
 * @param matchedNumbers - Issue numbers GitHub returned, best-first.
 * @param repo - The repo the search ran against.
 * @param itemsByProvenance - Local items keyed `owner/repo#N`.
 * @returns One hit per locally-present matching item.
 */
export declare function mapSearchHits(matchedNumbers: number[], repo: string, itemsByProvenance: Map<string, PmItem>): Array<{
    id: string;
    score: number;
    matched_fields: string[];
}>;
/**
 * Resolve the search target repo for the GitHub search provider.
 *
 * An explicit option wins, then the `PM_GITHUB_REPO` env var so a workspace can
 * pin its upstream. Returns `undefined` when neither yields an `owner/repo`.
 *
 * @param options - The raw option object from the search context.
 * @returns The resolved `owner/repo`, or `undefined`.
 */
export declare function resolveSearchRepo(options: Record<string, unknown>): string | undefined;
/**
 * Structured result of `pm github validate`.
 *
 * Reports the resolved token source, whether the `gh` CLI is installed, the
 * current rate-limit snapshot, and (when a repo is given) its reachability.
 * `ok` is the overall pass/fail; `messages` carries the human-readable detail.
 */
export interface ValidateReport {
    /** Overall pass/fail for the validation. */
    ok: boolean;
    /** Whether the `gh` CLI was found on PATH. */
    gh_cli: boolean;
    /** Whether any GitHub token was resolvable. */
    token: boolean;
    /** Where the token came from: `env`, `gh`, or `none`. */
    token_source: "env" | "gh" | "none";
    /** The repo examined, when one was supplied. */
    repo?: string;
    /** Whether the repo responded 2xx. */
    repo_accessible?: boolean;
    /** Raw HTTP status the repo check returned. */
    repo_status?: number;
    /** Remaining requests in the current rate-limit window. */
    rate_limit_remaining?: number;
    /** Total requests permitted per window. */
    rate_limit_limit?: number;
    /** Epoch seconds at which the window resets. */
    rate_limit_reset?: number;
    /** Whether the remaining quota is at/under the low-water mark. */
    rate_limit_low?: boolean;
    /** Human-readable diagnostic lines. */
    messages: string[];
}
/** One project-summary node in a `projectsV2` connection. */
interface GraphqlProjectsV2Node {
    number: number;
    title?: string;
    url?: string;
    closed?: boolean;
    shortDescription?: string | null;
}
/** A `projectsV2` connection (user or organization), as returned by the listing
 * query. */
interface GraphqlProjectsV2Connection {
    pageInfo?: {
        hasNextPage?: boolean;
        endCursor?: string;
    };
    nodes?: Array<GraphqlProjectsV2Node | null>;
}
/** Response shape of the `listOwnerProjectsV2Nodes` query — one of
 * user/organization resolves, the other is null. */
interface GraphqlListOwnerProjectsData {
    user?: {
        projectsV2?: GraphqlProjectsV2Connection | null;
    } | null;
    organization?: {
        projectsV2?: GraphqlProjectsV2Connection | null;
    } | null;
}
/**
 * One page of a `projectsV2` connection as returned by GitHub GraphQL.
 *
 * Carries the page's nodes and the cursor threading needed to fetch the rest.
 */
export interface ProjectsV2Page {
    /** Project-summary nodes on this page (null entries are redacted/inaccessible). */
    nodes?: Array<GraphqlProjectsV2Node | null>;
    /** Relay pagination info for the next page. */
    pageInfo?: {
        hasNextPage?: boolean;
        endCursor?: string;
    };
}
export declare function collectProjectsV2Pages(fetchPage: (cursor: string | undefined) => Promise<ProjectsV2Page | null | undefined>): Promise<GraphqlProjectsV2Node[]>;
export type GraphQLTransport = (query: string, variables: Record<string, unknown>) => Promise<GraphqlListOwnerProjectsData>;
/**
 * Resolve and paginate the `projectsV2` connection for a user-or-org owner.
 *
 * A login is either a user or an organization, never both; querying both in one
 * request resolves the owner type without an extra round-trip, then this keeps
 * paginating the connection that actually exists so owners with more than 100
 * projects are fully listed instead of silently truncated.
 *
 * @param owner - The user or org login.
 * @param graphQL - Injectable transport (query + variables → data), for tests.
 * @returns Every project-summary node for the owner.
 */
export declare function listOwnerProjectsV2Nodes(owner: string, graphQL: GraphQLTransport): Promise<GraphqlProjectsV2Node[]>;
/**
 * Build the `pm` CLI argv that applies one pull (project → pm) status transition.
 *
 * Pure so the pm lifecycle contract is unit-testable without spawning `pm`:
 * `closed` goes through `pm close`; `canceled` keeps its distinct terminal state
 * via `pm update --status canceled` with `--close-reason`; everything else is a
 * plain `pm update --status`. See the long note above for the pm CLI contracts.
 *
 * @param entry - The pull-plan entry to render argv for.
 * @param pmRoot - Workspace root for the `pm` invocation.
 * @returns The argv array.
 */
export declare function buildPullEntryArgs(entry: PullPlanEntryLike, pmRoot: string): string[];
interface PullPlanEntryLike {
    itemId: string;
    pmId: string;
    title: string;
    fromStatus: string;
    toStatus: string;
}
/**
 * Report whether a github subcommand will mutate GitHub.
 *
 * Feeds the host CLI's "mutating command" guard, accounting for the `--dry-run`
 * and `--apply` overrides that turn an otherwise-mutating command into a preview.
 *
 * @param command - The subcommand string (e.g. `github sync`).
 * @param options - The raw option object from the command handler.
 * @returns True when the command will perform real GitHub writes.
 */
export declare function isMutatingGithubCommand(command: string, options: Record<string, unknown>): boolean;
declare const _default: {
    name: string;
    version: string;
    activate(api: ExtensionApi): void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map