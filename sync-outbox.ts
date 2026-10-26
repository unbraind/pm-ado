/** Durable package intents for revision-checked Azure effects and recoverable creation. */
import { mkdir, readFile, chmod, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ItemMetadata, LockLease } from "@unbrained/pm-cli/sdk";
import type { Values } from "./sync.ts";
import { loadResolutionSdk, resolutionDigest } from "./resolution.ts";
import { AdoClient, AdoHttpError, CommandError, EXIT_CODE, RevisionConflict, type AdoConfig, type AdoWorkItem, type JsonPatchOperation } from "./index.ts";

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

/** Durable knowledge about one original Azure plan, including definitive refusal. */
export type OutboxState = "prepared" | "dispatched" | "observed" | "rejected";
/** Every input affecting durable operation knowledge, including a corrected retry. */
export type OutboxEvent = "dispatch" | "success" | "rejection" | "ambiguity" | "retry";
/** Total transition table; successful proof is never downgraded by a later failure. */
export const OUTBOX_TRANSITIONS: Readonly<Record<OutboxState, Readonly<Record<OutboxEvent, OutboxState>>>> = {
  prepared: { dispatch: "dispatched", success: "observed", rejection: "rejected", ambiguity: "dispatched", retry: "prepared" },
  dispatched: { dispatch: "dispatched", success: "observed", rejection: "rejected", ambiguity: "dispatched", retry: "dispatched" },
  observed: { dispatch: "observed", success: "observed", rejection: "observed", ambiguity: "observed", retry: "observed" },
  rejected: { dispatch: "dispatched", success: "observed", rejection: "rejected", ambiguity: "dispatched", retry: "prepared" },
};

/** Distinguish a proven atomic refusal from an unknown external outcome. */
export function classifyOutboxFailure(error: unknown): "rejection" | "ambiguity" {
  return error instanceof RevisionConflict || error instanceof AdoHttpError && error.status >= 400 && error.status < 500 && error.status !== 408
    ? "rejection" : "ambiguity";
}

/** Private journal record, retained across commands and local revision conflicts. */
interface Intent {
  /** Versioned package outbox contract. */
  schema: "pm-ado/outbox/1";
  /** Scope digest prevents cross-project recovery. */
  scope: string;
  /** Local identity owning this side effect. */
  item: string;
  /** Non-idempotent create or revision-conditional PATCH. */
  operation: "create" | "patch";
  /** Local identity, operation and canonical original plan digest. */
  key: string;
  /** Original work item type, empty for PATCH. */
  type: string;
  /** Original scalar request, never replaced by a retry's edited local values. */
  fields: Record<string, unknown>;
  /** Original canonical local values, retained for three-way recovery before linking. */
  base: Values | null;
  /** Original relation request, protected by the remote revision assertion. */
  relations: JsonPatchOperation[];
  /** Zero until Azure assigns an identity. */
  remote: number;
  /** Zero for creation, otherwise the asserted revision. */
  revision: number;
  /** Dispatch is durable before POST; ambiguous outcomes never authorize another POST. */
  state: OutboxState;
  /** Exact successful response, recoverable even when subsequent local linking refuses. */
  response?: AdoWorkItem;
}

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
export function isProtocolTag(tag: string): boolean {
  return /^pm-ado-idempotency-[a-f0-9]{64}$/u.test(tag.trim().toLowerCase());
}

/** Serialize shared-tracker effects with SDK leases and atomically persisted private intents. */
export class SyncOutbox {
  private readonly sdk = loadResolutionSdk();
  private readonly scope: string;
  private readonly pmRoot: string;
  private readonly author: string;
  private readonly client: AdoClient;
  private readonly observer: SyncObserver | undefined;
  /** Bind the existing real Azure client and tracker to one attributable caller. */
  constructor(pmRoot: string, author: string, config: AdoConfig, client: AdoClient, observer?: SyncObserver) {
    this.pmRoot = pmRoot; this.author = author; this.client = client; this.observer = observer;
    this.scope = resolutionDigest([config.orgUrl, config.project]);
    this.project = config.project;
  }
  private readonly project: string;

  /** Derive the stable creation marker without exposing local identity in Azure tags. */
  private marker(intent: Intent): string { return `pm-ado-idempotency-${resolutionDigest([this.scope, intent.key])}`; }

  /** Persist through the SDK's atomic file writer, with private file permissions. */
  private async save(path: string, intent: Intent, lease: LockLease): Promise<void> {
    await this.observer?.({ boundary: "intent", phase: "before", operation: intent.state, item: intent.item });
    await lease.fence(async () => {
      await this.sdk.writeFileAtomic(path, JSON.stringify(intent));
      await chmod(path, 0o600);
    });
    await this.observer?.({ boundary: "intent", phase: "after", operation: intent.state, item: intent.item });
  }

  /** Keep the first create plan stable across local edits, under a fenced SDK lease. */
  private async withIntent<T>(initial: Omit<Intent, "schema" | "scope" | "key" | "state">,
    run: (intent: Intent, persist: () => Promise<void>, replan: () => Promise<void>, changed: boolean) => Promise<T>): Promise<T> {
    const key = `${initial.item}:${initial.operation}:${resolutionDigest([this.scope, initial])}`;
    const name = resolutionDigest([this.scope, initial.item, initial.operation, initial.operation === "create" ? "" : key]);
    const directory = join(this.pmRoot, "transactions/pm-ado-sync");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${name}.json`);
    const settings = await this.sdk.readSettings(this.pmRoot);
    const lease = await this.sdk.acquireLockLease(this.pmRoot, `ado-outbox-${name}`, settings.locks.ttl_seconds,
      this.author, false, settings.governance.force_required_for_stale_lock, settings.locks.wait_ms);
    try {
      let intent: Intent;
      const persist = () => this.save(path, intent, lease);
      try { intent = JSON.parse(await readFile(path, "utf8")) as Intent; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        intent = { ...initial, schema: "pm-ado/outbox/1", scope: this.scope, key, state: "prepared" };
        await persist();
      }
      this.validate(intent, initial.item, initial.operation);
      /** Only an undispatched or durably rejected plan may be replaced by corrected input. */
      const replan = async () => {
        Object.assign(intent, initial, { key, state: OUTBOX_TRANSITIONS[intent.state].retry });
        delete intent.response;
        await persist();
      };
      return await run(intent, persist, replan, intent.key !== key);
    } finally { await lease.release(); }
  }

  /** Refuse altered scope, ownership or plan bytes before consulting remote identities. */
  private validate(intent: Intent, item: string, operation: Intent["operation"]): void {
    const { schema, scope, key, state, response: _response, ...plan } = intent;
    if (schema !== "pm-ado/outbox/1" || scope !== this.scope || plan.item !== item || plan.operation !== operation ||
        key !== `${plan.item}:${plan.operation}:${resolutionDigest([scope, plan])}` ||
        !["prepared", "dispatched", "observed", "rejected"].includes(state)) {
      throw new CommandError("Azure outbox intent is invalid; preserve it and inspect recovery before retrying", EXIT_CODE.conflict);
    }
  }

  /** Record successful effect proof, including a response recovered by marker lookup. */
  private async accept(intent: Intent, persist: () => Promise<void>, response: AdoWorkItem): Promise<AdoWorkItem> {
    intent.response = response;
    intent.state = OUTBOX_TRANSITIONS[intent.state].success;
    await persist();
    return response;
  }

  /** One outcome policy for every create/PATCH, with dispatch durable before effects. */
  private async execute(intent: Intent, persist: () => Promise<void>, request: () => Promise<AdoWorkItem>): Promise<AdoWorkItem> {
    intent.state = OUTBOX_TRANSITIONS[intent.state].dispatch;
    await persist();
    let response: AdoWorkItem;
    try { response = await request(); }
    catch (error) {
      intent.state = OUTBOX_TRANSITIONS[intent.state][classifyOutboxFailure(error)];
      await persist();
      throw error;
    }
    return this.accept(intent, persist, response);
  }

  /** Recover pending export owners before import/sync can allocate another local identity. */
  async owners(remotes: readonly AdoWorkItem[], locals: readonly ItemMetadata[]): Promise<Map<number, { item: string; creation: CreatedRemote }>> {
    const owners = new Map<number, { item: string; creation: CreatedRemote }>();
    for (const local of locals.filter((item) => item.ado_id === undefined || item.ado_sync_base === undefined)) {
      const name = resolutionDigest([this.scope, local.id, "create", ""]);
      let intent: Intent;
      try { intent = JSON.parse(await readFile(join(this.pmRoot, "transactions/pm-ado-sync", `${name}.json`), "utf8")) as Intent; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      this.validate(intent, local.id, "create");
      const matches = remotes.filter((remote) => remote.id === intent.response?.id ||
        String(remote.fields["System.Tags"] ?? "").split(";").some((tag) => tag.trim() === this.marker(intent)));
      if (matches.length > 1 || matches.length === 1 && owners.has(matches[0]!.id)) {
        throw new CommandError("Azure outbox ownership is ambiguous; preserve both identities and inspect recovery", EXIT_CODE.conflict);
      }
      if (matches.length) owners.set(matches[0]!.id, { item: local.id, creation: await this.creation(intent, matches[0]!, true) });
    }
    return owners;
  }

  /** Recover actual creation defaults rather than treating an unfinished link as a legacy base. */
  private async creation(intent: Intent, remote: AdoWorkItem, recovered: boolean): Promise<CreatedRemote> {
    const accepted = intent.response ?? (remote.rev === 1 ? remote :
      await this.client.request("GET", `/_apis/wit/workitems/${remote.id}/revisions/1?api-version=7.1&$expand=relations`) as AdoWorkItem);
    if (accepted.id !== remote.id || accepted.rev !== 1 ||
        !String(accepted.fields["System.Tags"]).split(";").some((tag) => tag.trim() === this.marker(intent))) {
      throw new CommandError("Azure creation acceptance does not prove the scoped intent", EXIT_CODE.conflict);
    }
    return { remote, recovered, base: intent.base, accepted };
  }

  /** Reconcile a proven prior PATCH before treating its own effect as a competing writer. */
  async bases(remotes: readonly AdoWorkItem[], locals: readonly ItemMetadata[]): Promise<Map<string, { original: Values; accepted: AdoWorkItem }>> {
    const directory = join(this.pmRoot, "transactions/pm-ado-sync");
    const recovered = new Map<string, { original: Values; accepted: AdoWorkItem }>();
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return recovered; throw error; }
    const localById = new Map(locals.map((item) => [item.id, item]));
    const remoteById = new Map(remotes.map((item) => [item.id, item]));
    const records: Intent[] = [];
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const intent = JSON.parse(await readFile(join(directory, name), "utf8")) as Intent;
      if (intent.operation === "patch" && intent.scope === this.scope) records.push(intent);
    }
    // The last proven operation wins, even if several attempts failed to publish locally.
    for (const intent of records.sort((left, right) => left.revision - right.revision)) {
      const local = localById.get(intent.item);
      const current = remoteById.get(intent.remote);
      if (local === undefined || current === undefined || local.ado_id !== intent.remote || !Number.isSafeInteger(local.ado_rev) || Number(local.ado_rev) > intent.revision ||
          intent.base === null || intent.state === "prepared" || intent.state === "rejected" || current.rev <= intent.revision) continue;
      this.validate(intent, local.id, "patch");
      const accepted = await this.client.request("GET", `/_apis/wit/workitems/${intent.remote}/revisions/${intent.revision + 1}?api-version=7.1&$expand=relations`) as AdoWorkItem;
      if (accepted.fields["System.History"] !== `pm-ado operation ${intent.key}`) continue;
      recovered.set(local.id, { original: intent.base, accepted });
    }
    return recovered;
  }

  /** Find the stamped object before considering creation; never silently choose between duplicate markers. */
  private async lookup(intent: Intent): Promise<AdoWorkItem | undefined> {
    const marker = this.marker(intent);
    const project = this.project.replaceAll("'", "''");
    const ids = await this.client.queryIds(`SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${project}' AND [System.Tags] CONTAINS '${marker}'`, 2);
    if (ids.length > 1) throw new CommandError("Azure creation marker is not unique; inspect the remote identities before retrying", EXIT_CODE.conflict);
    if (ids.length === 0) return undefined;
    const [remote] = await this.client.getWorkItems(ids);
    if (remote === undefined || !String(remote.fields["System.Tags"]).split(";").some((tag) => tag.trim() === marker)) {
      throw new CommandError("Azure marker lookup did not return the exact scoped object", EXIT_CODE.conflict);
    }
    return remote;
  }

  /** Reuse the first durable create intent and remote marker after crashes or failed local links. */
  async create(item: string, type: string, fields: Record<string, unknown>, base: Values | null = null): Promise<CreatedRemote> {
    return this.withIntent({ item, operation: "create", type, fields, base, relations: [], remote: 0, revision: 0 }, async (intent, persist, replan, changed) => {
      const found = await this.lookup(intent);
      if (found !== undefined) {
        const creation = await this.creation(intent, found, true);
        await this.accept(intent, persist, creation.accepted);
        return creation;
      }
      if (intent.response !== undefined) {
        const current = await this.client.getWorkItemsReport([intent.response.id]);
        if (current.missing.length) throw new CommandError("Recorded Azure creation is unavailable; preserve its intent. No replacement POST was sent.", EXIT_CODE.conflict);
        return this.creation(intent, current.items[0]!, true);
      }
      if (intent.state === "rejected" || intent.state === "prepared" && changed) await replan();
      if (intent.state !== "prepared") {
        throw new CommandError("Azure create outcome is uncertain and its marker is not visible; retry lookup later. No second POST was sent.", EXIT_CODE.conflict);
      }
      await this.observer?.({ boundary: "remote", phase: "before", operation: "create", item });
      const remote = await this.execute(intent, persist, async () => {
        const marked = [String(intent.fields["System.Tags"] ?? ""), this.marker(intent)].filter(Boolean).join("; ");
        let response: AdoWorkItem;
        try { response = await this.client.createWorkItem(intent.type, { ...intent.fields, "System.Tags": marked }); }
        finally { await this.observer?.({ boundary: "remote", phase: "after", operation: "create", item }); }
        // A malformed 2xx response proves neither rejection nor a usable identity.
        await this.creation({ ...intent, response }, response, false);
        return response;
      });
      return this.creation(intent, remote, false);
    });
  }

  /** Journal links/comments/scalars before PATCH; its revision assertion makes exact replay safe. */
  async patch(item: string, remote: AdoWorkItem, fields: Record<string, unknown>, relations: readonly JsonPatchOperation[], base: Values | null = null): Promise<AdoWorkItem> {
    return this.withIntent({ item, operation: "patch", type: "", fields, base, relations: [...relations], remote: remote.id, revision: remote.rev }, async (intent, persist, replan) => {
      if (intent.response !== undefined) return intent.response;
      const marker = `pm-ado operation ${intent.key}`;
      if (intent.state === "dispatched") {
        const [current] = await this.client.getWorkItems([intent.remote]);
        if (current.rev > intent.revision) {
          const historical = await this.client.request("GET", `/_apis/wit/workitems/${intent.remote}/revisions/${intent.revision + 1}?api-version=7.1&$expand=relations`) as AdoWorkItem;
          if (historical.fields["System.History"] !== marker) {
            intent.state = OUTBOX_TRANSITIONS[intent.state].rejection;
            await persist();
            throw new RevisionConflict(intent.remote, intent.revision, current);
          }
          return this.accept(intent, persist, historical);
        }
      }
      if (intent.state === "rejected") await replan();
      const outgoing: Record<string, unknown> = { ...intent.fields, "System.History": marker };
      if (Object.hasOwn(outgoing, "System.Tags")) {
        const protocol = String(remote.fields["System.Tags"] ?? "").split(";").filter(isProtocolTag);
        outgoing["System.Tags"] = [String(outgoing["System.Tags"]), ...protocol].filter(Boolean).join("; ");
      }
      return this.execute(intent, persist, () => this.client.updateWorkItem(intent.remote, intent.revision, outgoing, intent.relations));
    });
  }
}
