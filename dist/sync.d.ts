/** Command orchestration and per-field Azure DevOps reconciliation. */
import type { CommandHandlerContext, FlagDefinition } from "@unbrained/pm-cli/sdk/authoring";
import type { ItemMetadata } from "@unbrained/pm-cli/sdk";
import { type AdoWorkItem } from "./index.ts";
/** Default Azure state names mapped to local lifecycle states. */
export declare const IMPORT_STATE_MAP: Readonly<Record<string, string>>;
/** Shared flags are typed by the host, which also owns JSON/TOON rendering. */
export declare const SYNC_FLAGS: FlagDefinition[];
/** Canonical field values shared by remote, local and persisted base snapshots. */
type Values = Record<string, string | number | string[]>;
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
/** Escape WIQL literals; explicit WIQL cannot be combined with generated filters. */
export declare function buildWiql(options: Record<string, unknown>, project: string): string;
/** Project Azure fields into the same normalized shape as local metadata. */
export declare function remoteValues(item: AdoWorkItem, mapping: Readonly<Record<string, string>>): Values;
/** Project pm fields, preserving unrelated metadata outside this mapping. */
export declare function localValues(item: ItemMetadata): Values;
/** Build and apply one command plan using only the host-bound SDK client. */
export declare function runSyncCommand(ctx: CommandHandlerContext, mode: "import" | "export" | "sync"): Promise<{
    ok: boolean;
    code: string;
    exit_code: 4;
    dry_run: boolean;
    plans: Plan[];
    conflicts: Conflict[];
    diagnostics: unknown[];
    error?: undefined;
} | {
    ok: boolean;
    dry_run: boolean;
    plans: Plan[];
    conflicts: Conflict[];
    diagnostics: unknown[];
    code?: undefined;
    exit_code?: undefined;
    error?: undefined;
} | {
    ok: boolean;
    code: string;
    exit_code: number;
    dry_run: boolean;
    plans: Plan[];
    conflicts: Conflict[];
    diagnostics: unknown[];
    error: string;
}>;
export {};
//# sourceMappingURL=sync.d.ts.map