/** Shared field representations for SDK writes and semantic comparison; raw guards stay opaque. */
import type { Values } from "./sync.ts";
import type * as Sdk from "@unbrained/pm-cli/sdk";
/** Native SDK and tracker schema used by both projection and persistence. */
export interface ValueNormalization {
    /** Host-owned namespace, preserving extension registration identity. */
    sdk: typeof Sdk;
    /** Configured runtime schema; unknown historical statuses retain their raw value. */
    schema: Sdk.PmSettings["schema"];
    /** Configured prefix for operator item references. */
    idPrefix: string;
}
/** Canonical statuses resolved by native host schema reads without a module link. */
export interface StatusReferenceNormalization {
    /** Resolve only values certified by the host SDK registry. */
    resolveStatus(value: string): string;
}
/** Resolve lifecycle aliases through the same SDK registry used by native updates. */
export declare function normalizeStatusValue(value: string, context?: ValueNormalization | StatusReferenceNormalization): string;
/** Canonical identities resolved by native host reads when no SDK module link exists. */
export interface ItemReferenceNormalization {
    /** Resolve only references already certified by the host SDK client. */
    resolveReference(value: string): string;
}
/** Canonical operator IDs use native SDK resolution, case, hash-marker and prefix rules. */
export declare function normalizeItemReference(value: string, context?: ValueNormalization | ItemReferenceNormalization): string;
/** Host-owned text normalization for metadata discovery without a package SDK module link. */
export interface TitleReferenceNormalization {
    /** Project the exact required text value used by the export writer. */
    resolveTitle(value: string): string;
}
/** Required text shares SDK trimming; the fallback stays SDK-free for metadata-only discovery. */
export declare function normalizeTitleValue(value: string, context?: ValueNormalization | Partial<TitleReferenceNormalization>): string;
/** Assignment names preserve case while sharing SDK trimming and legacy scalar-clear semantics. */
export declare function normalizeAssigneeValue(value: string, context?: ValueNormalization): string;
/** SDK tag normalization precedes the existing locale-independent set comparison order. */
export declare function normalizeTagValues(value: readonly string[], context?: ValueNormalization): string[];
/** Numeric SDK priorities retain invalid historical values for evaluation; native writes still validate them. */
export declare function normalizePriorityValue(value: string | number, context?: ValueNormalization): string | number;
/** Provider classification text is literal: SDK custom-field writes preserve its case, whitespace and Unicode. */
export declare function normalizeLiteralValue(value: string): string;
/** Scope uses the same trimming and organization trailing-slash rule as package configuration writes. */
export declare function normalizeScopeValue(value: string, organization?: boolean): string;
/** Normalize only mapped semantic fields, retaining unknown coordinates and partial-base markers verbatim. */
export declare function normalizeFieldValues(values: Readonly<Values>, context?: ValueNormalization): Values;
/** Canonicalize mapping interpretation without changing Azure's literal state names or inherited-key safety. */
export declare function normalizeStateMaps(maps: {
    imports: Readonly<Record<string, string>>;
    exports: Readonly<Record<string, string>>;
}, context?: ValueNormalization | StatusReferenceNormalization): {
    imports: {
        [k: string]: string;
    };
    exports: {
        [k: string]: string;
    };
};
//# sourceMappingURL=normalization.d.ts.map