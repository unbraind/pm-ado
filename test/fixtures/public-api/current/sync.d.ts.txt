import { type ValueNormalization } from "./normalization.ts";
import { type SyncObserver } from "./sync-outbox.ts";
import type { CommandHandlerContext, FlagDefinition } from "@unbrained/pm-cli/sdk/authoring";
import type { ItemMetadata, PmUpdateActionOptions, PmClient } from "@unbrained/pm-cli/sdk";
import { type AdoConfig, type AdoRelation, type AdoWorkItem } from "./index.ts";
/** Default Azure state names mapped to local lifecycle states. */
export declare const IMPORT_STATE_MAP: Readonly<Record<string, string>>;
/** Shared flags are typed by the host, which also owns JSON/TOON rendering. */
export declare const SYNC_FLAGS: FlagDefinition[];
/** Canonical field values shared by remote, local and persisted base snapshots. */
export type Values = Record<string, string | number | string[]>;
/** One actionable three-way or revision conflict. */
interface Conflict {
    /** Local identity, or null for a work item not imported yet. */
    pm_id: string | null;
    /** Azure numeric identity. */
    ado_id: number;
    /** Last locally recorded revision. */
    stored_rev: unknown;
    /** Current revision observed remotely. */
    remote_rev: number | null;
    /** Differing field values, including their common base where available. */
    fields: Record<string, {
        base?: unknown;
        local: unknown;
        remote: unknown;
    }>;
}
/** A planned item operation, returned unchanged by dry-run. */
interface Plan {
    /** Local identity, absent until a new import is committed. */
    pm_id: string | null;
    /** Remote identity, absent until an export creation succeeds. */
    ado_id: number | null;
    /** Operation direction or explicit no-op. */
    action: string;
    /** Fields imported into pm. */
    import_fields: string[];
    /** Fields exported to Azure. */
    export_fields: string[];
    /** Provenance fields already persisted after a successful remote creation. */
    linked_fields?: string[];
}
/** Stable command receipt; native races retain the established ADO_CONFLICT envelope and typed field evidence. */
export interface SyncCommandResult {
    /** Whether every selected operation completed. */
    ok: boolean;
    /** Preview mode does not commit either tracker. */
    dry_run: boolean;
    /** Planned and completed operation coordinates. */
    plans: Plan[];
    /** Three-way field conflicts observed before effects. */
    conflicts: Conflict[];
    /** Unmapped relation and transport diagnostics. */
    diagnostics: unknown[];
    /** Existing CLI machine code. */
    code?: string;
    /** Existing process exit contract. */
    exit_code?: number;
    /** Human-readable refusal, when present. */
    error?: string;
    /** Forward-only conflict class, also available with compact output. */
    kind?: "sync_conflict";
    /** Exact native target and before/current field values. */
    sync_conflict?: {
        code: "sync_conflict";
        pm_id: string | null;
        fields: Record<string, {
            base: unknown;
            current: unknown;
        }>;
    };
}
/** Detect a field requiring an explicit decision rather than choosing either writer. */
export declare function threeWayFieldConflict(local: unknown, remote: unknown, base: unknown): boolean;
/** Parse an optional JSON state map and reject unusable configuration before reads. */
export declare function stateMap(raw: string | undefined, defaults: Readonly<Record<string, string>>): Record<string, string>;
/** Escape WIQL literals; explicit WIQL cannot be combined with generated filters. */
export declare function buildWiql(options: Record<string, unknown>, project: string): string;
/** Project Azure fields into the same normalized shape as local metadata. */
export declare function remoteValues(item: AdoWorkItem, mapping: Readonly<Record<string, string>>, normalization?: ValueNormalization | false): Values;
/** Project pm fields, preserving unrelated metadata outside this mapping. */
export declare function localValues(item: ItemMetadata, normalization?: ValueNormalization | false): Values;
/** Decode and validate the dedicated base; missing legacy bases never imply a winner. */
export declare function readBase(item: ItemMetadata, sample: Values, normalization?: ValueNormalization | false): Values | undefined;
/** Exact field mapping used by reconciliation and remote-contract discovery. */
export declare const ADO_FIELD_MAP: Readonly<Record<string, string>>;
/** Convert agreed canonical values to Azure reference names for changed fields only. */
export declare function azureFields(values: Values, keys: readonly string[], states: Record<string, string>, normalization?: ValueNormalization | false): Record<string, unknown>;
/** Convert canonical fields and provenance to one SDK mutation with a history record. */
export declare function pmFields(values: Values, remote: AdoWorkItem, config: AdoConfig, normalization?: ValueNormalization): PmUpdateActionOptions & {
    field: string[];
};
/** Canonical recognized relations; opaque or out-of-scope links stay with the adapter. */
export declare function relationValues(relations: readonly AdoRelation[], config: AdoConfig, identities: ReadonlyMap<number, string>): string[];
/** Read actual local graph edges independently of a remote snapshot or proposed patch. */
export declare function readLocalAgreement(pm: Pick<PmClient, "listAllComplete">, id: string, config: AdoConfig, expectedVersion?: string, normalization?: ValueNormalization): Promise<{
    item: import("@unbrained/pm-cli/sdk").ListTreeItem | import("@unbrained/pm-cli/sdk").ListedItem;
    identities: Map<number, string>;
    values: {
        relations: string[];
    };
    version: string;
    base: Values | undefined;
    acknowledgedRevision: number | undefined;
}>;
/** Project mapped scalars through SDK normalization, retaining only an explicit equivalent export witness. */
export declare function remoteScalarValues(remote: AdoWorkItem, preferred: Values | undefined, imports: Readonly<Record<string, string>>, exports: Readonly<Record<string, string>>, normalization?: ValueNormalization | false): Values;
/** Compare actual expanded Azure and local reads in the same native field representation. */
export declare function remoteAgreement(remote: AdoWorkItem, local: Values, config: AdoConfig, identities: ReadonlyMap<number, string>, imports: Readonly<Record<string, string>>, exports: Readonly<Record<string, string>>, normalization?: ValueNormalization): Values;
/** Compare a proven owned effect without claiming its unrelated remote fields were ever agreed. */
export declare function recoveredField(local: unknown, remote: unknown, original: unknown, accepted: unknown): "local" | "remote" | "conflict";
/** Evidence of an owned remote effect, kept separate from the agreed common base. */
export interface OwnedEffect {
    /** Local projection before the owned request. */
    original: Values;
    /** Accepted remote projection, whose unrelated keys are never common base. */
    accepted: Values;
    /** Scalar keys actually included in that request. */
    keys: string[];
    /** Revision asserted by the owned request; a later witnessed key retires this proof. */
    revision: number;
}
/** Choose each key from its witnessed base or the latest proof for that exact owned scalar. */
export declare function mergeSyncValues(local: Values, remote: Values, base: Values | undefined, effect?: OwnedEffect | readonly OwnedEffect[], normalization?: ValueNormalization): Record<string, "equal" | "local" | "remote" | "conflict">;
/** Execute the real REST transport; failures are converted to stable command receipts. */
export declare function transport(method: string, url: string, body: string | undefined, headers: Readonly<Record<string, string>>): Promise<{
    status: number;
    body: string;
}>;
/** Build and apply one command plan using only the host-bound SDK client. */
export declare function runSyncCommand(ctx: CommandHandlerContext, mode: "import" | "export" | "sync", observer?: SyncObserver, sdkAnchors?: readonly string[]): Promise<SyncCommandResult>;
export {};
//# sourceMappingURL=sync.d.ts.map