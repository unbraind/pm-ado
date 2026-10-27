import type { Values } from "./sync.ts";
/** Local state read after the command's mutations, including its last agreed base. */
export interface LocalAgreementRead {
    /** Canonical synced scalar and relation values from the real tracker. */
    values: Values;
    /** Item version that must still match when publishing agreement. */
    version: string;
    /** Previously acknowledged values; absent keys remain unknown. */
    base?: Values;
    /** Last acknowledged Azure revision; a stale read cannot move it backward. */
    acknowledgedRevision?: number;
}
/** Azure state read after the command's effects, never a request or cached response. */
export interface RemoteAgreementRead {
    /** Canonical synced values from an expanded current Azure read. */
    values: Values;
    /** Revision returned by that actual Azure read. */
    revision: number;
}
/** Read-back and conditional storage operations supplied by the SDK-bound caller. */
export interface AgreementOperations {
    /** Read local values from the tracker after writes. */
    readLocal(): Promise<LocalAgreementRead>;
    /** Read Azure after writes; local state can select a documented state-map alias. */
    readRemote(local: LocalAgreementRead): Promise<RemoteAgreementRead>;
    /** Refuse a peer edit rather than adopting its newer revision as our own. */
    expectedVersion: string;
    /** Earliest Azure revision that can include this command's completed effects. */
    minimumRemoteRevision: number;
    /** Publish only these witnessed values, matched to the local read version. */
    publish(base: Values, revision: number | undefined, version: string): Promise<void>;
}
/** The precise keys that still disagree, alongside both actual read-back witnesses. */
export interface AgreementResult {
    /** Last witnessed per-key agreements; divergent keys retain their prior base. */
    base: Values;
    /** Synced keys that are not yet equal on both sides. */
    differences: string[];
    /** Native local read used by the agreement rule. */
    local: LocalAgreementRead;
    /** Native Azure read used by the agreement rule. */
    remote: RemoteAgreementRead;
}
/** Decode per-key read-back revision witnesses; legacy bases have no per-key coordinates. */
export declare function readBaseRevisions(base: Values | undefined): Record<string, number>;
/** Read explicit field membership; complete legacy bases retain their original own-field evidence. */
export declare function baseFields(base: Values | undefined): string[];
/** Project only fields whose presence is certified, preserving opaque revision metadata. */
export declare function knownBase(base: Values): Values;
/** The same per-field revision predicate is used by hydration planning and persisted read-back evidence. */
export declare function fieldAtRevision(field: string, fields: readonly string[], savedRevision: number | null, observedRevision: number, revisions?: Readonly<Record<string, number>>): boolean;
/** Advance each key only from matching post-operation reads; acknowledge a revision only on full agreement. */
export declare function advanceSyncBase(operations: AgreementOperations): Promise<AgreementResult>;
//# sourceMappingURL=agreement.d.ts.map