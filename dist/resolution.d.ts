import type * as Sdk from "@unbrained/pm-cli/sdk";
import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import { AdoClient, type AdoConfig, type AdoWorkItem } from "./index.ts";
/** Stable refusals agents can branch on without parsing error prose. */
export type ResolutionRefusalCode = "invalid_plan" | "invalid_choices" | "stale_local" | "stale_remote" | "scope" | "configuration" | "apply_failed";
/** A failed decision with a concrete recovery action; server bodies are never exposed. */
export declare class ResolutionRefusal extends Error {
    /** Semantic conflict exit propagated by the host runtime. */
    readonly exitCode = 4;
    /** Stable reason for refusing the decision. */
    readonly code: ResolutionRefusalCode;
    /** Concrete recovery action for the agent. */
    readonly remedy: string;
    /** Preserve the machine-readable reason and caller remedy. */
    constructor(code: ResolutionRefusalCode, remedy: string);
    /** Preserve semantic refusals and map REST races without exposing service bodies. */
    static from(error: unknown): ResolutionRefusal;
}
/** A field decision chooses an observed value, never an unchecked replacement. */
export interface ResolutionChoice {
    /** Canonical pm field from the existing sync map. */
    field: string;
    /** Snapshot whose value wins on both sides. */
    take: "local" | "remote";
}
/** Compact field coordinates avoid copying titles, descriptions or identities into plans. */
export interface ResolutionField {
    /** Canonical field name. */
    field: string;
    /** Digest of the last shared value, or null for a legacy missing base. */
    base: string | null;
    /** Digest of the observed pm value. */
    local: string;
    /** Digest of the observed Azure value. */
    remote: string;
    /** Both writers changed this field since the base. */
    conflict: boolean;
}
/** Portable artifact; a core Plan item may store this JSON in its body. */
export interface ResolutionPlan {
    /** Versioned package decision contract, independent of core Plan storage. */
    schema: "pm-ado/resolution/1";
    /** Azure scope; never includes the access token. */
    scope: {
        org: string;
        project: string;
    };
    /** Exact local identity and canonical whole-document revision digest. */
    local: {
        id: string;
        revision: string;
    };
    /** Azure identity, revision and full REST snapshot digest. */
    remote: {
        id: number;
        revision: number;
        digest: string;
    };
    /** Digests for every mapped scalar field; no implicit field winner. */
    fields: ResolutionField[];
    /** Normalized state-map digest prevents configuration changes reinterpreting decisions. */
    mapping: string;
    /** Exactly one choice per differing field; initially empty for agent review. */
    choices: ResolutionChoice[];
}
/** Successful application receipt, intentionally independent of private field values. */
export interface ResolutionReceipt {
    /** Successful commit or an already committed decision. */
    ok: true;
    /** Stable idempotency coordinate including the selected choices. */
    decision: string;
    /** True when the saved receipt already proves application. */
    replayed: boolean;
    /** Local item whose immutable history holds the decision. */
    pm_id: string;
}
/** Hash recursively sorted JSON so artifact property order has no semantics. */
export declare function resolutionDigest(value: unknown): string;
/** Resolve the public SDK from this package or the running host, including copied extensions. */
export declare function loadResolutionSdk(anchors?: readonly string[]): typeof Sdk;
/** Refuse malformed portable input before opening a mutation or contacting Azure. */
export declare function validateResolutionPlan(input: unknown): asserts input is ResolutionPlan;
/** Configured state interpretation bound into every portable plan. */
export interface ResolutionMaps {
    /** Azure-to-pm lifecycle states. */
    imports: Readonly<Record<string, string>>;
    /** pm-to-Azure lifecycle states. */
    exports: Readonly<Record<string, string>>;
}
/** Build digests from the same field projections and three-way base used by sync. */
export declare function resolutionFields(item: Sdk.ItemMetadata, remote: AdoWorkItem, maps: ResolutionMaps): ResolutionField[];
/** Revision-bound decisions use core reads, Plan storage and audited item mutation, never git. */
export declare class AdoResolutionService {
    private readonly pmRoot;
    private readonly author;
    private readonly pm;
    private readonly client;
    private readonly config;
    private readonly sdk;
    /** Bind one public SDK workspace and Azure REST client to an attributable caller. */
    constructor(pmRoot: string, author: string, pm: Sdk.PmClient, client: AdoClient, config: AdoConfig, sdk?: typeof Sdk);
    /** Load authoritative item bytes with the same SDK normalization used by the mutation lock. */
    private document;
    /** Check identity and scope on every read, including when applying a portable artifact. */
    private scope;
    /** Require one hydrated REST work item rather than accepting an omitted batch row. */
    private remote;
    /** Read normalized configured maps once per operation and bind their interpretation to the plan. */
    private maps;
    /** Preview one linked item's scalar decisions with no tracker or REST writes. */
    plan(id: string): Promise<ResolutionPlan>;
    /** Apply under the core item lease; validate all choices and both revisions before a REST write. */
    apply(input: unknown): Promise<ResolutionReceipt>;
}
/** CLI bridge with host-owned compact TOON/JSON rendering and core Plan persistence. */
export declare function runResolutionCommand(ctx: CommandHandlerContext, mode: "plan" | "apply"): Promise<ResolutionReceipt | {
    ok: boolean;
    plan_id: string;
    plan: ResolutionPlan;
    code?: undefined;
    remedy?: undefined;
    exit_code?: undefined;
} | {
    plan_id?: undefined;
    ok: boolean;
    plan: ResolutionPlan;
    code?: undefined;
    remedy?: undefined;
    exit_code?: undefined;
} | {
    plan_id?: undefined;
    plan?: undefined;
    ok: boolean;
    code: ResolutionRefusalCode;
    remedy: string;
    exit_code: number;
}>;
//# sourceMappingURL=resolution.d.ts.map