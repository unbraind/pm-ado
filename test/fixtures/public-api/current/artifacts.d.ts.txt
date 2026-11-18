/** Read-only delivery evidence at the Azure work-item revisions observed in one batch. */
import type { PmClient } from "@unbrained/pm-cli/sdk";
import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import { type AdoConfig, type AdoTransport } from "./index.ts";
/** Maximum selected items and distinct links returned for each item. */
export declare const ARTIFACT_LIMITS: {
    readonly items: 20;
    readonly linksPerItem: 10;
};
type BuildKind = "build" | "found_in_build" | "integrated_in_build";
/** Whitelisted coordinates extracted from a work item ArtifactLink. */
export type ArtifactLink = {
    kind: "pull_request";
    project_id: string;
    repository_id: string;
    id: number;
} | {
    kind: BuildKind;
    id: number;
};
/** One requested PM identity, including evidence gaps for its Azure work item. */
export interface ArtifactRow {
    /** Canonical PM ID and scoped Azure work item ID. */
    pm_id: string;
    ado_id: number;
    /** Observed Azure revision, or null when Azure omitted the requested item. */
    rev: number | null;
    /** Distinct recognized links, ordered by kind and canonical coordinates. */
    links: ArtifactLink[];
    /** Counts of recognized links beyond the cap and out-of-scope or malformed references. */
    omitted_links: number;
    unsupported_links: number;
    invalid_links: number;
}
/** Successful read-only plan. Inspect complete before drawing conclusions from absence. */
export interface ArtifactPlan {
    ok: true;
    complete: boolean;
    rows: ArtifactRow[];
}
/** Stable failures shared by the CLI and SDK. */
export type ArtifactRefusalCode = "configuration" | "selection" | "read_failure";
/** Refuse invalid or ambiguous evidence without exposing request details. */
export declare class ArtifactRefusal extends Error {
    /** Machine-readable failure category. */
    readonly code: ArtifactRefusalCode;
    /** Shell exit forwarded by the host: 2 for input and 3 for read failure. */
    readonly exitCode: number;
    /** Capture a stable refusal code and operator remedy. */
    constructor(code: ArtifactRefusalCode);
}
/**
 * Observe explicit imported identities through a complete, host-bound SDK read.
 * One Azure relation batch supplies the evidence after resolving a configured project ID.
 * The function reads both trackers without writing to them. Git and Pipelines
 * status and artifact URLs are outside this preview.
 */
export declare function observeArtifactPlan(pm: Pick<PmClient, "listAllComplete">, config: AdoConfig, request: AdoTransport, ids: readonly string[]): Promise<ArtifactPlan>;
/** Run the preview through the host SDK and let the host render JSON or TOON. */
export declare function runArtifactCommand(ctx: CommandHandlerContext): Promise<ArtifactPlan | {
    ok: boolean;
    code: ArtifactRefusalCode;
    remedy: string;
    exit_code: number;
}>;
export {};
//# sourceMappingURL=artifacts.d.ts.map