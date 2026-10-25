import type { ItemMetadata } from "@unbrained/pm-cli/sdk";
import type { Values } from "./sync.ts";
import { AdoClient, type AdoConfig, type AdoWorkItem, type JsonPatchOperation } from "./index.ts";
/** Observable SDK/REST boundaries; observers never provide or replace storage or transport. */
export interface SyncBoundary {
    /** Operation domain whose durable boundary was reached. */
    boundary: "remote" | "local" | "intent";
    /** Immediately before or after the operation. */
    phase: "before" | "after";
    /** Safe operation name, excluding item contents and credentials. */
    operation: string;
    /** Local identity when already allocated. */
    item?: string;
}
/** Optional boundary observer for diagnostics and real process-crash acceptance. */
export type SyncObserver = (event: SyncBoundary) => void | Promise<void>;
/** Creation ownership and its initial accepted snapshot survive delayed local publication. */
export interface CreatedRemote {
    /** Current scoped Azure object. */
    remote: AdoWorkItem;
    /** True when the durable creation predates this attempt. */
    recovered: boolean;
    /** Original canonical local values, before any external side effect. */
    base: Values | null;
    /** Azure's accepted creation snapshot, including server defaults. */
    accepted: AdoWorkItem;
}
/** Recognize only the reserved complete marker, preserving ordinary user tags. */
export declare function isProtocolTag(tag: string): boolean;
/** Serialize shared-tracker effects with SDK leases and atomically persisted private intents. */
export declare class SyncOutbox {
    private readonly sdk;
    private readonly scope;
    private readonly pmRoot;
    private readonly author;
    private readonly client;
    private readonly observer;
    /** Bind the existing real Azure client and tracker to one attributable caller. */
    constructor(pmRoot: string, author: string, config: AdoConfig, client: AdoClient, observer?: SyncObserver);
    private readonly project;
    /** Derive the stable creation marker without exposing local identity in Azure tags. */
    private marker;
    /** Persist through the SDK's atomic file writer, with private file permissions. */
    private save;
    /** Keep the first create plan stable across local edits, under a fenced SDK lease. */
    private withIntent;
    /** Refuse altered scope, ownership or plan bytes before consulting remote identities. */
    private validate;
    /** Recover pending export owners before import/sync can allocate another local identity. */
    owners(remotes: readonly AdoWorkItem[], locals: readonly ItemMetadata[]): Promise<Map<number, {
        item: string;
        creation: CreatedRemote;
    }>>;
    /** Recover actual creation defaults rather than treating an unfinished link as a legacy base. */
    private creation;
    /** Reconcile a proven prior PATCH before treating its own effect as a competing writer. */
    bases(remotes: readonly AdoWorkItem[], locals: readonly ItemMetadata[]): Promise<Map<string, {
        original: Values;
        accepted: AdoWorkItem;
    }>>;
    /** Find the stamped object before considering creation; never silently choose between duplicate markers. */
    private lookup;
    /** Reuse the first durable create intent and remote marker after crashes or failed local links. */
    create(item: string, type: string, fields: Record<string, unknown>, base?: Values | null): Promise<CreatedRemote>;
    /** Journal links/comments/scalars before PATCH; its revision assertion makes exact replay safe. */
    patch(item: string, remote: AdoWorkItem, fields: Record<string, unknown>, relations: readonly JsonPatchOperation[], base?: Values | null): Promise<AdoWorkItem>;
}
//# sourceMappingURL=sync-outbox.d.ts.map