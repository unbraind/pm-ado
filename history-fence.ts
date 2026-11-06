/** Forward-only native lifecycle writes; conflicts never restore earlier tracker state. */
import type * as Sdk from "@unbrained/pm-cli/sdk";
import { randomUUID } from "node:crypto";

/** Monotonic native revision; wall clocks and document equality are not revisions. */
export interface NativeHead {
  /** Number of immutable native records. */
  length: number;
  /** Hash of the last native record. */
  hash: string;
}

/** Validate portable witnesses, including a legacy tracker with no native history yet. */
export function isNativeHead(value: unknown): value is NativeHead {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const head = value as Partial<NativeHead>;
  return Number.isSafeInteger(head.length) && Number(head.length) >= 0 &&
    (head.length === 0 ? head.hash === "empty" : typeof head.hash === "string" && /^[a-f0-9]{64}$/u.test(head.hash));
}

/** A peer edit invalidated the inspected plan, including an ABA edit. */
export class NativeHistoryConflict extends Error {
  readonly exitCode = 4;
  readonly code = "ADO_CONFLICT";
  /** Stable forward-only class alongside the compatible CLI envelope. */
  readonly kind = "sync_conflict";
  /** Canonical local target, when a guarded write has selected one. */
  readonly item: string | null;
  /** Saved and current field values; null represents an absent field. */
  readonly fields: Record<string, { base: unknown; current: unknown }>;
  /** Return a structured, forward-only conflict without rewriting either writer's work. */
  constructor(item: string | null = null, fields: Record<string, { base: unknown; current: unknown }> = {}) {
    super("Local sync state changed; re-read both trackers and re-plan from current tracker state."); this.item = item; this.fields = fields;
  }
}

/** Use the SDK's native record chain as the only local revision witness. */
export async function nativeHead(sdk: typeof Sdk, pmRoot: string, id: string): Promise<NativeHead> {
  const { entries } = await sdk.readHistorySnapshot(sdk.getHistoryPath(pmRoot, id), id);
  const last = entries.at(-1);
  return { length: entries.length, hash: last === undefined ? "empty" : last.record_hash ?? sdk.hashHistoryRecord(last) };
}

/** Inspect native state before each write and detect intervening events without compensation. */
export class NativeWriteFence {
  private readonly heads = new Map<string, NativeHead>();
  private readonly snapshots = new Map<string, Sdk.ItemDocument>();
  /** Upper bound from final revision read to the latest SDK write completing, in milliseconds. */
  lastWriteWindowMs = 0;
  /** Bind real SDK lifecycle operations; the optional dispatch also supports host-owned adapters. */
  private readonly sdk: typeof Sdk;
  private readonly pmRoot: string;
  private readonly author: string;
  private readonly write: (id: string, options: Sdk.PmUpdateActionOptions) => Promise<unknown>;
  /** Bind SDK operations without replacing their hierarchy or permission validation. */
  constructor(sdk: typeof Sdk, pmRoot: string, author: string,
    write?: (id: string, options: Sdk.PmUpdateActionOptions) => Promise<unknown>) {
    this.sdk = sdk; this.pmRoot = pmRoot; this.author = author;
    this.write = write ?? ((id, options) => sdk.update(id, options, { pmRoot }));
  }

  /** Read authoritative normalized fields through settings-aware SDK location. */
  private async document(id: string): Promise<Sdk.ItemDocument> {
    const settings = await this.sdk.readSettings(this.pmRoot);
    const located = await this.sdk.locateItem(this.pmRoot, id, settings.id_prefix, settings.item_format,
      this.sdk.resolveItemTypeRegistry(settings, this.sdk.getActiveExtensionRegistrations()).type_to_folder);
    if (located === null) throw new NativeHistoryConflict(id, { item: { base: "present", current: null } });
    return (await this.sdk.readLocatedItem(located, { schema: settings.schema })).document;
  }

  /** Capture current state for a new plan; abandoned journals never replay old writes. */
  async capture(id: string): Promise<void> {
    const head = await nativeHead(this.sdk, this.pmRoot, id), document = await this.document(id);
    this.heads.set(id, head); this.snapshots.set(id, document);
  }

  /** Bind a newly created item to its SDK birth receipt rather than adopting a later peer edit. */
  async captureCreated(created: Sdk.ItemMetadata): Promise<void> {
    const { entries } = await this.sdk.readHistorySnapshot(this.sdk.getHistoryPath(this.pmRoot, created.id), created.id);
    const birth = entries[0];
    if (birth?.op !== "create") throw new NativeHistoryConflict(created.id);
    const document = this.sdk.replayToItemDocument(this.sdk.replayHistoryToTarget(entries, 0));
    if (!this.sdk.stableValueEquals(document.metadata, created)) throw new NativeHistoryConflict(created.id);
    this.snapshots.set(created.id, document);
    this.heads.set(created.id, { length: 1, hash: birth.record_hash ?? this.sdk.hashHistoryRecord(birth) });
    await this.assertCurrent(created.id);
  }

  /** Copy the portable native coordinate used by resolution plans. */
  head(id: string): NativeHead { return { ...this.heads.get(id)! }; }

  /** Build field evidence from saved and current SDK-normalized documents. */
  private conflict(id: string, current: Sdk.ItemDocument, keys?: readonly string[]): NativeHistoryConflict {
    const previous = this.snapshots.get(id)!;
    const before = new Map(Object.entries({ ...previous.metadata, body: previous.body }));
    const after = new Map(Object.entries({ ...current.metadata, body: current.body }));
    const fields = Object.fromEntries((keys ?? [...new Set([...before.keys(), ...after.keys()])]).filter((key) => key !== "updated_at" &&
      !this.sdk.stableValueEquals(before.get(key), after.get(key))).map((key) => [key, { base: before.get(key) ?? null, current: after.get(key) ?? null }]));
    return new NativeHistoryConflict(id, fields);
  }

  /** Refuse advanced native history, including fixed-clock ABA, without any reverse mutation. */
  async assertCurrent(id: string): Promise<void> {
    const current = await nativeHead(this.sdk, this.pmRoot, id), expected = this.heads.get(id);
    if (expected === undefined) throw new NativeHistoryConflict(id, { history: { base: null, current } });
    if (current.length !== expected.length || current.hash !== expected.hash) {
      const conflict = this.conflict(id, await this.document(id));
      if (!Object.keys(conflict.fields).length) conflict.fields.history = { base: expected, current };
      throw conflict;
    }
  }

  /** Recheck every captured head so query limits and filters never narrow the fence. */
  async assertAll(): Promise<void> {
    for (const id of [...this.heads.keys()]) await this.assertCurrent(id);
  }

  /** Verify owned event suffixes and their document without advancing the decision baseline. */
  private async writtenState(id: string, expected: NativeHead, message: string, operation: string | undefined): Promise<{ current: Sdk.ItemDocument; head: NativeHead }> {
    const { entries } = await this.sdk.readHistorySnapshot(this.sdk.getHistoryPath(this.pmRoot, id), id);
    const current = await this.document(id);
    const suffix = entries.slice(expected.length);
    const document = suffix.length ? this.sdk.replayToItemDocument(this.sdk.replayHistoryToTarget(entries, entries.length - 1)) : this.snapshots.get(id)!;
    if (suffix.some((entry) => entry.author !== this.author || (operation === undefined ?
      entry.message !== message : entry.agent_provenance?.ado_operation?.value !== operation)) ||
      !this.sdk.stableValueEquals(current, document)) {
      const conflict = this.conflict(id, current);
      if (!Object.keys(conflict.fields).length) conflict.fields.history = { base: expected, current: await nativeHead(this.sdk, this.pmRoot, id) };
      throw conflict;
    }
    const last = entries.at(-1);
    return { current, head: { length: entries.length, hash: last === undefined ? "empty" : last.record_hash ?? this.sdk.hashHistoryRecord(last) } };
  }

  /** Re-read changed fields, write forward once, and report races without restoring anything. */
  async update(id: string, options: Sdk.PmUpdateActionOptions, transactionId: string): Promise<string> {
    if (!this.snapshots.has(id)) throw new NativeHistoryConflict(id);
    const keys = [...Object.keys(options).filter((key) => !["field", "unset", "dep", "message", "author", "force"].includes(key)),
      ...(options.field ?? []).map((field) => field.split("=")[0]), ...(options.unset ?? []),
      ...(options.dep !== undefined || options.clearDeps || options.replaceDeps ? ["dependencies"] : []), ...(options.status !== undefined ? ["assignee"] : [])];
    const conflict = this.conflict(id, await this.document(id), keys);
    if (Object.keys(conflict.fields).length) throw conflict;
    await this.assertCurrent(id);
    const expected = this.heads.get(id)!;
    const message = `bulk-item-transaction ${transactionId} apply${options.message === undefined ? "" : `; ${options.message}`}`;
    // Bind to the decision document, never a later revision read that could adopt a peer edit.
    // Older supported hosts retain their documented history-detection-only behavior.
    const readAt = performance.now();
    let unchecked = false;
    const operation = typeof this.sdk.runWithAgentSessionContext === "function" ? randomUUID() : undefined;
    try {
      const dispatch = () => this.write(id, { ...options, author: this.author, message });
      const write = () => operation === undefined ? dispatch() :
        this.sdk.runWithAgentSessionContext({ provenance: { ado_operation: operation } }, dispatch);
      if (typeof this.sdk.withExpectedItemRevisions === "function") {
        const receipt = await this.sdk.withExpectedItemRevisions(
          [{ id, itemHash: this.sdk.hashDocument(this.snapshots.get(id)!) }], write, { pmRoot: this.pmRoot });
        unchecked = receipt.unchecked.length > 0;
      } else await write();
    }
    catch (error) {
      await this.writtenState(id, expected, message, operation);
      if (typeof this.sdk.isItemRevisionConflict === "function" && this.sdk.isItemRevisionConflict(error)) throw this.conflict(id, await this.document(id));
      throw error;
    }
    finally { this.lastWriteWindowMs = performance.now() - readAt; }
    if (unchecked) {
      const conflict = this.conflict(id, await this.document(id));
      conflict.message = "Native dispatch completed without a revision check; re-read both trackers and re-plan from current tracker state.";
      throw conflict;
    }
    const { current, head } = await this.writtenState(id, expected, message, operation);
    this.snapshots.set(id, current);
    this.heads.set(id, head);
    await this.assertCurrent(id);
    return current.metadata.updated_at;
  }
}
