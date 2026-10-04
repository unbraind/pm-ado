/**
 * Identifies one GitHub Projects v2 board by its owner and project number.
 *
 * This is the human-facing handle used across the CLI (`--project owner/number`)
 * and parsed from board URLs by {@link parseProjectRef}; the board's stable
 * GraphQL node id lives separately in {@link ProjectMeta}.
 */
export interface ProjectRef {
    /** Login of the user or organization that owns the board. */
    owner: string;
    /** The board's project number, as it appears in the URL path after `/projects/` (not a database id). */
    number: number;
}
export interface ProjectStatusOption {
    id: string;
    name: string;
}
export interface ProjectStatusField {
    id: string;
    name: string;
    options: ProjectStatusOption[];
}
export type ProjectOwnerType = "user" | "organization";
/**
 * Lightweight metadata describing one Projects v2 board.
 *
 * Fetched up front (before any item-level work) so `project list` can render a
 * chooser and the command handlers can decide whether a Status field exists.
 */
export interface ProjectMeta {
    /** GraphQL node id of the project (`PVT_…`), used as a stable key. */
    id: string;
    /** Human-readable board title shown by `project list`. */
    title: string;
    /** Browser URL of the board, surfaced in command output. */
    url: string;
    /** Whether the board is owned by a user account or an organization. */
    ownerType: ProjectOwnerType;
    /** The single-select "Status" field, if the project has one. */
    statusField?: ProjectStatusField;
}
export interface ProjectItemContent {
    typename: "DraftIssue" | "Issue" | "PullRequest" | "Unknown";
    title: string;
    body?: string;
    /** Issue/PR number (absent for draft issues). */
    number?: number;
    url?: string;
    /** GitHub issue/PR state, lowercased ("open" | "closed" | "merged"). */
    state?: string;
    stateReason?: string | null;
    /** owner/repo the issue/PR lives in (absent for draft issues). */
    repo?: string;
}
export interface ProjectItem {
    /** ProjectV2Item node id — the stable idempotency key. */
    id: string;
    /** Selected Status option id, if any. */
    statusOptionId?: string;
    /** Selected Status option name, if any. */
    statusName?: string;
    content: ProjectItemContent;
}
export interface PmItemLike {
    id?: string;
    title?: string;
    status?: string;
    body?: string;
    description?: string;
    tags?: string[];
}
export declare function parseProjectRef(input: string | undefined): ProjectRef | undefined;
export declare function encodeItemId(id: string): string;
export declare function decodeItemId(encoded: string): string | undefined;
export declare function projectItemTag(ref: ProjectRef, itemId: string): string;
export declare function parseProjectItemTag(tag: string): {
    owner: string;
    number: number;
    itemId: string;
} | undefined;
export declare function issueProvenanceTag(repo: string, number: number): string;
export declare const DEFAULT_STATUS_CANDIDATES: Record<string, string[]>;
/**
 * Parse a `--status-map` option into a forward table (pm status → exact Status
 * option name).
 *
 * Accepts `pm=OptionName` pairs, comma-separated or repeated. Entries without a
 * `=` or with an empty side are skipped. Returns `undefined` when no usable
 * mapping was supplied so callers keep the default candidate-list behavior.
 *
 * @param raw - The raw string array handed to the `--status-map` CLI option.
 * @returns The parsed forward mapping, or `undefined` if nothing usable was supplied.
 */
export declare function parseStatusMap(raw: string[]): Map<string, string> | undefined;
/**
 * Resolve which board Status option a given pm status should be written to,
 * measured against the project's real single-select options.
 *
 * An explicit `--status-map` override wins; otherwise the default candidate
 * list is tried in order. Returns `undefined` when nothing matches — the caller
 * must SKIP the write rather than guess, so a real state is never overwritten
 * with a wrong one (the module's no-data-loss invariant).
 *
 * @param pmStatus - The pm status to place on the board (defaults to "open").
 * @param options - The board's actual Status options to match against.
 * @param override - Optional forward map from `--status-map`; takes precedence.
 * @returns The matching option, or `undefined` on a hard miss.
 */
export declare function resolveOptionForStatus(pmStatus: string | undefined, options: Array<ProjectStatusOption | null | undefined>, override?: Map<string, string>): ProjectStatusOption | undefined;
/**
 * Reverse-map a board Status option name back to a pm status (used by pull).
 *
 * An explicit forward `--status-map` is inverted first (option name → pm
 * status); otherwise a keyword heuristic classifies the name. Returns
 * `undefined` for names that match no bucket so pull SKIPS them instead of
 * forcing a wrong pm status onto the item.
 *
 * @param optionName - The Status option name read from the board.
 * @param override - Optional forward map from `--status-map`; inverted first.
 * @returns The pm status, or `undefined` when the name is unrecognized.
 */
export declare function mapOptionNameToPmStatus(optionName: string | undefined, override?: Map<string, string>): string | undefined;
/**
 * Index pm items by the project-item id they are linked to, scoped to one board.
 *
 * Scans each item's tags for a {@link projectItemTag} whose owner/number match
 * `ref`, so a sync can find the existing pm item behind a given board item in
 * O(1) rather than re-scanning the whole list.
 *
 * @param items - The pm items to index (nullish entries are ignored).
 * @param ref - The board whose project-item linkage is wanted.
 * @returns A map from decoded project-item id to the linked pm item.
 */
export declare function indexPmByProjectItem(items: Array<PmItemLike | null | undefined>, ref: ProjectRef): Map<string, PmItemLike>;
/**
 * Index pm items by their `owner/repo#number` issue-provenance tag.
 *
 * Lets a push attach an already-imported pm item to the existing issue's project
 * item (via {@link indexProjectItemsByIssue}) rather than creating a duplicate
 * draft on the board.
 *
 * @param items - The pm items to index (nullish entries are ignored).
 * @returns A map keyed `owner/repo#number` (lowercased owner) to the pm item.
 */
export declare function indexPmByIssue(items: Array<PmItemLike | null | undefined>): Map<string, PmItemLike>;
/**
 * Index board items by the issue they wrap (`owner/repo#number`).
 *
 * Pairs with {@link indexPmByIssue} so a push can locate the existing board item
 * for a pm item that is issue-linked but not yet carrying a project-item tag.
 *
 * @param projectItems - The board items to index (nullish entries are ignored).
 * @returns A map keyed `owner/repo#number` (lowercased owner) to the board item.
 */
export declare function indexProjectItemsByIssue(projectItems: Array<ProjectItem | null | undefined>): Map<string, ProjectItem>;
/**
 * The write operation one push-plan entry asks the executor to perform.
 *
 * - `add-draft` — create a new draft issue on the board for a pm item with no
 *   existing issue link.
 * - `add-issue` — attach an already-linked GitHub issue to the board instead of
 *   duplicating it as a draft.
 * - `set-status` — change the Status single-select of an item already on the
 *   board.
 * - `noop` — no write needed; carried so dry-run output can show why.
 */
export type PushAction = "add-draft" | "add-issue" | "set-status" | "noop";
/**
 * One pm item's resolved fate under the push plan, produced by
 * {@link buildProjectPushPlan}.
 *
 * Exactly one entry exists per pm item processed; the optional fields carry the
 * context each {@link PushAction} variant needs to execute or to explain itself
 * in `--dry-run` output.
 */
export interface PushPlanEntry {
    action: PushAction;
    pmId: string;
    title: string;
    /** Existing project-item id (present for set-status / already-linked). */
    itemId?: string;
    /** The Status option we intend to set (absent when unmapped). */
    targetOptionId?: string;
    targetOptionName?: string;
    /** The item's current Status option name (for divergence display). */
    currentOptionName?: string;
    /** For add-issue: the existing issue to attach, as owner/repo#number. */
    issueRepo?: string;
    issueNumber?: number;
    /** Why an entry is a noop / skipped-status (human readable). */
    reason?: string;
}
export interface PushPlan {
    entries: PushPlanEntry[];
    /** pm items whose status could not be mapped to any board option. */
    statusSkipped: Array<{
        pmId: string;
        title: string;
        status: string;
    }>;
}
export interface PushPlanOptions {
    /** When false, never add missing pm items to the board (only set status of
     * already-linked ones). Default true. */
    addMissing?: boolean;
    statusMap?: Map<string, string>;
}
export declare function buildProjectPushPlan(pmItems: Array<PmItemLike | null | undefined>, ref: ProjectRef, projectItems: ProjectItem[], statusField: ProjectStatusField | undefined, opts?: PushPlanOptions): PushPlan;
export interface PullPlanEntry {
    itemId: string;
    pmId: string;
    title: string;
    fromStatus: string;
    toStatus: string;
}
export interface PullPlan {
    entries: PullPlanEntry[];
    /** project items whose Status option name maps to no known pm status. */
    statusSkipped: Array<{
        itemId: string;
        optionName?: string;
    }>;
}
export declare function buildProjectPullPlan(pmItems: PmItemLike[], ref: ProjectRef, projectItems: ProjectItem[], statusMap?: Map<string, string>): PullPlan;
export interface ImportPlanEntry {
    action: "create" | "update";
    itemId: string;
    title: string;
    status: string;
    /**
     * The pm status explicitly mapped from the board's Status option, when the
     * option name resolved to a known pm status. Undefined when the board status
     * did NOT map (unknown option / no Status field) — the re-import update path
     * must then SKIP the status refresh (no --status) so a real pm state is never
     * overwritten with a guess (no-data-loss invariant, Greptile 2006f478). The
     * create path still falls back to `status` (issue state or "open").
     */
    mappedStatus?: string;
    body?: string;
    /** Tags to attach (project tag + optional issue tag). */
    tags: string[];
    /** Existing pm item id when action==="update". */
    pmId?: string;
    content: ProjectItemContent;
}
export declare function buildProjectImportPlan(projectItems: ProjectItem[], ref: ProjectRef, pmItems: PmItemLike[], statusMap?: Map<string, string>): ImportPlanEntry[];
//# sourceMappingURL=projects.d.ts.map