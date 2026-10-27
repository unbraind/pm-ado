/** Read-only Azure refresh compiler; artifacts describe reads and never authorize writes. */
import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import type { ItemMetadata, PmClient } from "@unbrained/pm-cli/sdk";
import { type AdoConfig, type AdoTransport } from "./index.ts";
/** Native pm fields whose Azure projection this package owns. */
export type RefreshField = "title" | "description" | "status" | "priority" | "tags" | "assignee" | "ado_area_path" | "ado_iteration_path" | "relations";
/** Compact revision/base evidence, without item contents. */
export interface RefreshSaved {
    /** Azure positive int32 identity. */
    id: number;
    /** Saved Azure revision, null for legacy links. */
    revision: number | null;
    /** Fields present in the saved base; a base is reusable only at its exact revision. */
    base: RefreshField[];
    /** Optional per-field witnessed revisions; missing entries are never cached. */
    revisions?: Record<string, number>;
}
/** Revision-only observation, obtained anew on every invocation. */
export interface RefreshRevision {
    /** Azure identity returned by the probe. */
    id: number;
    /** Current Azure positive int32 revision. */
    revision: number;
}
/** Strict portable compiler input; omitted observations compile just the probe phase. */
export interface RefreshInput {
    /** Declared native field needs, unique and nonempty. */
    needs: RefreshField[];
    /** Unique linked items, up to 10000. */
    saved: RefreshSaved[];
    /** Complete probe result; omitted IDs are unavailable, never deleted. */
    observed?: RefreshRevision[];
    /** Complete JSON receipt budget, 1024..1048576 bytes, default 65536. */
    maxOutputBytes?: number;
}
/** A directly usable Azure 7.1 batch request body. */
export interface RefreshBatch {
    /** At most 200 identities. */
    ids: number[];
    /** Smallest shared projection for this batch, including the revision guard. */
    fields: string[];
    /** Omission is an unavailable row, not a deletion. */
    errorPolicy: "omit";
    /** Relations are expanded only when declared and uncached. */
    $expand?: "relations";
}
/** Reviewable read costs and total per-field accounting; no mutation instructions. */
export interface RefreshPlan {
    /** Successful compilation, including explicitly unavailable rows. */
    ok: true;
    /** Stable portable artifact version. */
    schema: "pm-ado/refresh/1";
    /** Probe artifacts must be completed with fresh observations. */
    phase: "probe" | "refresh";
    /** Revision-only requests. */
    probe: RefreshBatch[];
    /** Follow-up requests for changed or uncached fields. */
    hydrate: RefreshBatch[];
    /** Exact-revision matches, independent of cache completeness. */
    unchanged: number[];
    /** Returned revisions differing from the saved revision. */
    changed: number[];
    /** Omitted probe identities; retry access, never delete. */
    unavailable: number[];
    /** Every declared need is cached, scheduled for reading, or unavailable. */
    accounting: {
        field: RefreshField;
        cached: number;
        read: number;
        unavailable: number;
        pending: number;
    }[];
    /** Foreign and unrelated records are skipped without claiming ownership. */
    skipped?: {
        reason: "unlinked" | "foreign_scope";
        count: number;
    }[];
    /** Bounded integer costs; mutations are always zero. */
    cost: {
        items: number;
        probe_reads: number;
        hydrate_reads: number;
        field_cells: number;
        pm_mutations: 0;
    };
}
/** Machine-readable refusal categories; messages never include tracker contents. */
export type RefreshRefusalCode = "invalid_input" | "scope" | "configuration" | "remote_failure" | "output_budget";
/** Typed, remedy-bearing failure shared by SDK and CLI callers. */
export declare class RefreshRefusal extends Error {
    /** Stable machine-readable category. */
    readonly code: RefreshRefusalCode;
    /** Concrete next action for the caller. */
    readonly remedy: string;
    /** Host command exit status. */
    readonly exitCode = 2;
    /** Construct a sanitized refusal without remote error bodies. */
    constructor(code: RefreshRefusalCode);
}
/** Single strict request schema, reused when remote observations enter the compiler. */
export declare function validateRefreshInput(value: unknown): asserts value is RefreshInput;
/** Compile fresh revision evidence into deterministic minimum-round-trip batch reads. Never applies or persists a plan. */
export declare function compileRefreshPlan(input: RefreshInput): RefreshPlan;
/** Project only owned Azure evidence from an SDK-certified tracker snapshot, skipping unrelated/foreign records. */
export declare function refreshSaved(items: readonly ItemMetadata[], config: AdoConfig): RefreshSaved[];
/** Probe through the existing Azure batch client, compile remaining reads, and leave both trackers unchanged. */
export declare function observeRefreshPlan(pm: Pick<PmClient, "listAllComplete">, config: AdoConfig, request: AdoTransport, needs: RefreshField[], maxOutputBytes?: number): Promise<RefreshPlan>;
/** Delegate complete reads and TOON/JSON rendering to the host SDK, without git or mutation APIs. */
export declare function runRefreshCommand(ctx: CommandHandlerContext): Promise<RefreshPlan | {
    ok: boolean;
    code: RefreshRefusalCode;
    remedy: string;
    exit_code: number;
}>;
//# sourceMappingURL=refresh.d.ts.map