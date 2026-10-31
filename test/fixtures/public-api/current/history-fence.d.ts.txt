/** Forward-only native lifecycle writes; conflicts never restore earlier tracker state. */
import type * as Sdk from "@unbrained/pm-cli/sdk";
/** Monotonic native revision; wall clocks and document equality are not revisions. */
export interface NativeHead {
    /** Number of immutable native records. */
    length: number;
    /** Hash of the last native record. */
    hash: string;
}
/** Validate portable witnesses, including a legacy tracker with no native history yet. */
export declare function isNativeHead(value: unknown): value is NativeHead;
/** A peer edit invalidated the inspected plan, including an ABA edit. */
export declare class NativeHistoryConflict extends Error {
    readonly exitCode = 4;
    readonly code = "ADO_CONFLICT";
    /** Stable forward-only class alongside the compatible CLI envelope. */
    readonly kind = "sync_conflict";
    /** Canonical local target, when a guarded write has selected one. */
    readonly item: string | null;
    /** Saved and current field values; null represents an absent field. */
    readonly fields: Record<string, {
        base: unknown;
        current: unknown;
    }>;
    /** Return a structured, forward-only conflict without rewriting either writer's work. */
    constructor(item?: string | null, fields?: Record<string, {
        base: unknown;
        current: unknown;
    }>);
}
/** Use the SDK's native record chain as the only local revision witness. */
export declare function nativeHead(sdk: typeof Sdk, pmRoot: string, id: string): Promise<NativeHead>;
/** Inspect native state before each write and detect intervening events without compensation. */
export declare class NativeWriteFence {
    private readonly heads;
    private readonly snapshots;
    /** Upper bound from final revision read to the latest SDK write completing, in milliseconds. */
    lastWriteWindowMs: number;
    /** Bind real SDK lifecycle operations; the optional dispatch also supports host-owned adapters. */
    private readonly sdk;
    private readonly pmRoot;
    private readonly author;
    private readonly write;
    /** Bind SDK operations without replacing their hierarchy or permission validation. */
    constructor(sdk: typeof Sdk, pmRoot: string, author: string, write?: (id: string, options: Sdk.PmUpdateActionOptions) => Promise<unknown>);
    /** Read authoritative normalized fields through settings-aware SDK location. */
    private document;
    /** Capture current state for a new plan; abandoned journals never replay old writes. */
    capture(id: string): Promise<void>;
    /** Bind a newly created item to its SDK birth receipt rather than adopting a later peer edit. */
    captureCreated(created: Sdk.ItemMetadata): Promise<void>;
    /** Copy the portable native coordinate used by resolution plans. */
    head(id: string): NativeHead;
    /** Build field evidence from saved and current SDK-normalized documents. */
    private conflict;
    /** Refuse advanced native history, including fixed-clock ABA, without any reverse mutation. */
    assertCurrent(id: string): Promise<void>;
    /** Re-read changed fields, write forward once, and report races without restoring anything. */
    update(id: string, options: Sdk.PmUpdateActionOptions, transactionId: string): Promise<string>;
}
//# sourceMappingURL=history-fence.d.ts.map