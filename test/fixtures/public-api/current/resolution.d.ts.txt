import type * as Sdk from "@unbrained/pm-cli/sdk";
import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import { AdoClient, type AdoConfig, type AdoWorkItem, type JsonPatchOperation } from "./index.ts";
import { type Values } from "./sync.ts";
/** Stable refusals agents can branch on without parsing error prose. */
export type ResolutionRefusalCode = "invalid_plan" | "invalid_choices" | "stale_local" | "stale_remote" | "scope" | "configuration" | "apply_failed" | "ado_partial_apply";
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
    /** Digest of the last shared value, or null when this key has no witnessed base. */
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
    schema: "pm-ado/resolution/2";
    /** Opaque credential-keyed scope reference; configuration is never persisted. */
    scope: {
        ref: string;
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
/** Optional SDK progress observer, invoked only after the recovery intent is durable. */
export type ResolutionObserver = (event: {
    /** Durable preparation has completed or an existing intent was recovered. */
    phase: "prepared";
    /** Opaque decision identity; field contents are excluded. */
    decision: string;
}) => void | Promise<void>;
/** Durable forward-recovery intent owned by the target item's audited metadata/history. */
export interface ResolutionIntent {
    /** Canonical reviewed plan and choice identity. */
    plan_id: string;
    /** Original local revision before the prepare mutation. */
    local_revision: string;
    /** Content fingerprint excluding only the prepare timestamp and intent itself. */
    guard: string;
    /** Bound Azure identity and revision before PATCH. */
    remote_id: number;
    /** Azure revision asserted by the saved PATCH. */
    remote_revision: number;
    /** Full remote snapshot before the side effect. */
    remote_digest: string;
    /** Revision expected after one PATCH, or unchanged for a local-only decision. */
    expected_remote_revision: number;
    /** Exact REST JSON Patch, including /rev test and unique history marker. */
    patch: JsonPatchOperation[];
    /** Reviewed canonical outcome, retained only on the target item. */
    values: Values;
    /** Existing per-key sync base; null preserves legacy absence. */
    base: Values | null;
}
/** Bind organization and project without storing either value or a dictionary-testable plain hash. */
export declare function resolutionScopeReference(config: AdoConfig): string;
/** Hash recursively sorted JSON so artifact property order has no semantics. */
export declare function resolutionDigest(value: unknown): string;
/** Load resolution primitives from package imports or caller-supplied anchors, never inferred launcher paths. */
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
    private readonly observer;
    /** Bind the tracker and REST client; omitted SDK preserves the legacy package-import default. */
    constructor(pmRoot: string, author: string, pm: Sdk.PmClient, client: AdoClient, config: AdoConfig, sdk?: typeof Sdk, observer?: ResolutionObserver);
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
    /** Fingerprint content independently of the prepare write's timestamp and recovery field. */
    private guard;
    /** Recognize durable settlement using the same immutable receipt used by normal replay. */
    private settled;
    /** Name the exact recovery coordinate without disclosing configuration or field contents. */
    private partial;
    /** Rebuild the exact guarded wire document from reviewed values, including an ownership marker. */
    private patch;
    /** Reject corrupted or substituted recovery data before using its stored PATCH. */
    private intent;
    /** Delegate lifecycle identity to the SDK without changing portable field or mapping digests. */
    private nativeStatus;
    /** Audit intent before the remote side effect; ordinary stale plans still make no item writes. */
    private prepare;
    /** Prove a prepared PATCH was applied, including its unique marker and complete mapped result. */
    private applied;
    /** Commit mapped values, lifecycle evidence and the settled receipt as one fenced SDK mutation. */
    private settle;
    /** Prepare durably, then resume or settle under core item leases without replaying a successful PATCH. */
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