/** Native lifecycle writes verified and compensated through immutable SDK history. */
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
    /** Return a stable refusal without leaking item content. */
    constructor();
}
/** Use the SDK's native record chain as the only local revision witness. */
export declare function nativeHead(sdk: typeof Sdk, pmRoot: string, id: string): Promise<NativeHead>;
/** Capture before inspecting, then carry only verified own revisions between writes. */
export declare class NativeWriteFence {
    private readonly heads;
    private readonly sdk;
    private readonly pmRoot;
    private readonly author;
    private readonly write;
    private readonly onTransition;
    private readonly journals;
    private inspectedJournals;
    /** Bind the host SDK without replacing extensions, hooks or lifecycle policy. */
    constructor(sdk: typeof Sdk, pmRoot: string, author: string, write?: (id: string, options: Sdk.PmUpdateActionOptions) => Promise<unknown>, onTransition?: Sdk.CommitWorkspaceTransactionOptions["onTransition"]);
    /** Recover interrupted verifications before a fresh inspection of this item. */
    capture(id: string): Promise<void>;
    /** Expose a copy for portable plans and locked preflight checks. */
    head(id: string): NativeHead;
    /** Refuse a read-back whose native history advanced even when no publication is needed. */
    assertCurrent(id: string): Promise<void>;
    /** Commit a native SDK update, then verify or selectively compensate inside its workspace transaction. */
    update(id: string, options: Sdk.PmUpdateActionOptions, transactionId: string): Promise<string>;
    /** Bind SDK journal identity to the immutable inspected head and payload, independent of timestamps. */
    private journalId;
    /** Replay the exact native marker after a crash; the SDK owns transaction journaling and lifecycle writes. */
    private commit;
}
//# sourceMappingURL=history-fence.d.ts.map