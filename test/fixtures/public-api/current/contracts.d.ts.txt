import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import type { ItemMetadata } from "@unbrained/pm-cli/sdk";
import { type AdoConfig, type AdoTransport } from "./index.ts";
import { type TitleReferenceNormalization, type StatusReferenceNormalization, type ValueNormalization } from "./normalization.ts";
/** Stable refusal vocabulary for SDK callers and host-rendered CLI results. */
export type ContractRefusalCode = "configuration" | "permission_denied" | "not_found" | "remote_failure" | "invalid_schema" | "schema_changed";
/** An actionable failure that contains no remote response body or credentials. */
export declare class ContractRefusal extends Error {
    /** Semantic shell exit used by the host command runtime. */
    readonly exitCode: number;
    /** Machine-readable reason for refusing discovery. */
    readonly code: ContractRefusalCode;
    /** Specific next step for the caller. */
    readonly remedy: string;
    /** Record a stable refusal code and remedy without exposing server details. */
    constructor(code: ContractRefusalCode, remedy: string, exitCode?: number);
    /** Preserve typed refusals, classify known configuration errors, and sanitize other failures. */
    static from(error: unknown): ContractRefusal;
}
/** Per-type metadata, normalized independently of friendly names and REST URLs. */
export interface ContractField {
    /** Stable Azure reference name. */
    ref: string;
    /** Azure field data type, retained for custom process fields. */
    type: string;
    /** False when Azure marks the field read-only; not an effective ACL check. */
    writable: boolean;
    /** Unconditional required-value metadata for this work item type. */
    required: boolean;
    /** Allowed metadata values, empty when Azure provides no enumeration. */
    allowed: unknown[];
    /** Process default, or null when absent. */
    default: unknown;
    /** Reference names participating in conditional field rules. */
    depends_on: string[];
}
/** A mapping incompatibility; counts aggregate tracker checks without item bodies. */
export interface ContractIssue {
    /** Stable machine-readable incompatibility code. */
    code: "missing_field" | "read_only" | "field_type" | "required_unmapped" | "export_state" | "import_state" | "relation_unavailable" | "item_type" | "item_value";
    /** Affected type, state, field or relation reference. */
    target: string;
    /** Occurrences aggregated across the checked snapshot. */
    count: number;
    /** Action needed before planning sync. */
    remedy: string;
}
/** Type availability and the fields/states an explicitly selected project exposes. */
export interface ContractType {
    /** Azure work item type name, including custom types. */
    name: string;
    /** Whether Azure disables this type. */
    disabled: boolean;
    /** State names exposed by this project type. */
    states: string[];
    /** Complete normalized field metadata for this type. */
    fields: ContractField[];
}
/** Organization-level relation capabilities; these flags do not establish caller ACLs. */
export interface ContractRelation {
    /** Stable Azure reference name. */
    ref: string;
    /** Relation capability flag, or null when not supplied. */
    enabled: boolean | null;
    /** Relation metadata flag, not a caller permission grant. */
    editable: boolean | null;
    /** Azure relation usage, or null when unspecified. */
    usage: string | null;
    /** Existing pm relation semantic, or null for unmapped custom types. */
    mapped: string | null;
}
/** Agent-readable result; successful discovery is distinct from mapping compatibility. */
export interface ProjectContract {
    /** Discovery succeeded; compatibility and permissions remain separate. */
    ok: true;
    /** Always true: discovery never writes either tracker. */
    preview: true;
    /** Explicit project selected by the caller. */
    project: string;
    /** SHA-256 over normalized remote metadata and scope. */
    fingerprint: string;
    /** No known incompatibilities found; does not certify permissions. */
    compatible: boolean;
    /** Read access observed; effective write access remains unknown. */
    permissions: {
        metadata_read: "allowed";
        field_write: "unknown";
        relation_write: "unknown";
        remedy: string;
    };
    /** Selected work item types, sorted by name. */
    types: ContractType[];
    /** Organization relation capabilities, sorted by reference name. */
    relations: ContractRelation[];
    /** Known mapping incompatibilities with actionable remedies. */
    issues: ContractIssue[];
    /** Number of snapshot items assessed, including unknown or disabled type diagnoses. */
    checked_items: number;
    /** Enabled items outside the selected type, excluded from compatibility checks. */
    skipped_items: number;
}
/** Optional type filter, schema pin, configured maps and complete SDK tracker snapshot. */
export interface ContractOptions {
    /** Optional work item type name; omit to inspect every project type. */
    type?: string;
    /** Refuse discovery if the normalized remote schema differs. */
    expectedFingerprint?: string;
    /** Local schema status IDs from the SDK, when tracker compatibility is checked. */
    localStatuses?: readonly string[];
    /** Existing local-to-Azure state overrides. */
    exportStates?: Readonly<Record<string, string>>;
    /** Existing Azure-to-local state overrides. */
    importStates?: Readonly<Record<string, string>>;
    /** Optional complete local snapshot supplied by the host SDK. */
    items?: readonly ItemMetadata[];
    /** Native status normalization, including custom aliases and host-owned registry lookup. */
    normalization?: ValueNormalization | (StatusReferenceNormalization & Partial<TitleReferenceNormalization>);
}
/**
 * Discover project WIT metadata using GET only, without an SDK mutation or git dependency.
 * Metadata cannot prove effective edit/link permissions or conditional process rules.
 * A schema fingerprint covers selected remote metadata, excluding tracker contents and maps.
 */
export declare function discoverProjectContract(config: AdoConfig, request: AdoTransport, options?: ContractOptions): Promise<ProjectContract>;
/** Run through the host SDK and renderer; failures carry stable codes and shell exits. */
export declare function runContractCommand(ctx: CommandHandlerContext): Promise<ProjectContract | {
    ok: boolean;
    preview: boolean;
    code: ContractRefusalCode;
    remedy: string;
    exit_code: number;
}>;
//# sourceMappingURL=contracts.d.ts.map