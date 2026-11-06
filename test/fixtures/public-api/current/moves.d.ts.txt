import { type ValueNormalization, type ItemReferenceNormalization } from "./normalization.ts";
/** Revision-bound classification previews using the shared contract and Azure's non-saving validator. */
import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import type { ItemMetadata } from "@unbrained/pm-cli/sdk";
import { type AdoConfig, type AdoTransport } from "./index.ts";
/** Hard bounds: one type contract, two batch reads and at most fifty validations. */
export declare const MOVE_LIMITS: {
    readonly items: 50;
    readonly relations: 200;
    readonly requests: 56;
};
/** Stable failures; validation never exposes Azure response messages or credentials. */
export type MoveRefusalCode = "configuration" | "selection" | "budget_exceeded" | "invalid_schema" | "remote_failure" | "permission_denied" | "not_found" | "process_rule" | "revision_changed" | "field_contract";
/** Sanitized actionable SDK exception with the host's semantic exit code. */
export declare class MoveRefusal extends Error {
    /** Stable refusal code for automated callers. */
    readonly code: MoveRefusalCode;
    /** Next action without remote error text. */
    readonly remedy: string;
    /** Usage errors exit 2; revision conflicts exit 4; other refusals exit 3. */
    readonly exitCode: number;
    /** Bind a stable refusal to its public remedy. */
    constructor(code: MoveRefusalCode);
}
/** Explicit selection from a complete SDK snapshot; no inferred bulk selection. */
export interface MoveOptions {
    /** Complete host SDK read, never a bounded list page. */
    items: readonly ItemMetadata[];
    /** Exact pm IDs selected by the caller. */
    ids: readonly string[];
    /** Optional destination area; omitted dimensions retain the observed value. */
    areaPath?: string;
    /** Optional destination iteration. */
    iterationPath?: string;
    /** Single work item type; defaults to Task to keep discovery bounded. */
    type?: string;
    /** Optional pin for the existing field contract fingerprint. */
    expectedFingerprint?: string;
}
/** Classification pair, with no title, description, identity or raw remote URL. */
export interface MoveScope {
    /** Azure area path. */
    area: string;
    /** Azure iteration path. */
    iteration: string;
}
/** One independent rule validation at an observed remote revision. */
export interface MoveRow {
    /** Selected pm identity. */
    id: string;
    /** Linked Azure identity. */
    ado_id: number;
    /** Revision validated, or null when the item is unavailable. */
    rev: number | null;
    /** Allowed means this single validation passed; it is not an apply authorization. */
    decision: "allowed" | "refused";
    /** Stable refusal or null for an allowed row. */
    code: MoveRefusalCode | null;
    /** Specific next step; empty for an allowed row. */
    remedy: string;
    /** Observed scope, null when unavailable. */
    before: MoveScope | null;
    /** Proposed scope, null when unavailable. */
    after: MoveScope | null;
}
/** A preserved direct link's classification boundary before/after all allowed proposals. */
export interface MoveRelation {
    /** Source Azure identity. */
    source: number;
    /** Azure relation reference name. */
    relation: string;
    /** Safe same-organization target identity, null for opaque external/resource links. */
    target: number | null;
    /** Links are never rewritten by classification moves. */
    action: "preserved";
    /** Whether endpoints share each classification, null for an unreadable/opaque target. */
    before: {
        area: boolean;
        iteration: boolean;
    } | null;
    /** Scope if every allowed row moves; refused rows retain their observed scope. */
    after: {
        area: boolean;
        iteration: boolean;
    } | null;
}
/** Compact deterministic preview with explicit completeness and request accounting. */
export interface MovePreview {
    /** True only when every selected row was allowed. */
    ok: boolean;
    /** Always true; no application capability is exposed. */
    preview: true;
    /** Existing metadata contract pin. */
    fingerprint: string;
    /** Total remote requests including discovery, batch reads and validateOnly calls. */
    requests: number;
    /** Single-item validation results, ordered by pm ID. */
    rows: MoveRow[];
    /** Direct links only; no transitive or team-board membership claim. */
    relations: MoveRelation[];
}
/**
 * Preview only explicit linked items. Azure evaluates inherited permissions and custom rules
 * through revision-checked PATCH validateOnly=true, bypassRules=false. No changes are saved.
 * Single-item validations are observations, not a transaction or a future permission grant.
 */
export declare function simulateMove(config: AdoConfig, request: AdoTransport, options: MoveOptions, normalization?: ValueNormalization | ItemReferenceNormalization): Promise<MovePreview>;
/** Read the complete host snapshot and delegate rendering to the pm command runtime. */
export declare function runMoveCommand(ctx: CommandHandlerContext): Promise<MovePreview | {
    ok: boolean;
    preview: boolean;
    code: "budget_exceeded" | "configuration" | "field_contract" | "invalid_schema" | "not_found" | "permission_denied" | "process_rule" | "remote_failure" | "revision_changed" | "schema_changed" | "selection";
    remedy: string;
    exit_code: number;
}>;
//# sourceMappingURL=moves.d.ts.map