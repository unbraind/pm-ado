/** Read-back witnesses for advancing only fields that both stores actually share. */
import { CommandError, EXIT_CODE } from "./index.ts";
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
export function readBaseRevisions(base: Values | undefined): Record<string, number> {
  if (base?.ado_agreed_revisions === undefined) return {};
  let revisions: unknown;
  try { revisions = JSON.parse(String(base.ado_agreed_revisions)); }
  catch { throw new CommandError("Invalid ado_sync_base agreement revisions"); }
  if (typeof revisions !== "object" || revisions === null || Array.isArray(revisions) ||
      Object.values(revisions).some((value) => !Number.isSafeInteger(value) || Number(value) < 1)) throw new CommandError("Invalid ado_sync_base agreement revisions");
  return revisions as Record<string, number>;
}

/** Read explicit field membership; complete legacy bases retain their original own-field evidence. */
export function baseFields(base: Values | undefined): string[] {
  if (base === undefined) return [];
  const keys = Object.keys(base).filter((key) => !["ado_base_partial", "ado_base_fields", "ado_agreed_revisions"].includes(key) && (key !== "relations" || Array.isArray(base[key]) && (base[key] as string[]).every((value) => typeof value === "string")));
  if (Object.hasOwn(base, "ado_base_fields")) return Array.isArray(base.ado_base_fields)
    ? [...new Set(base.ado_base_fields.filter((key) => typeof key === "string" && keys.includes(key)))].sort() : [];
  return base.ado_base_partial === 1 ? [] : keys.sort();
}
/** Project only fields whose presence is certified, preserving opaque revision metadata. */
export function knownBase(base: Values): Values {
  const fields = new Set(baseFields(base));
  return Object.fromEntries(Object.entries(base).filter(([key]) => fields.has(key) || ["ado_base_partial", "ado_base_fields", "ado_agreed_revisions"].includes(key)));
}
/** The same per-field revision predicate is used by hydration planning and persisted read-back evidence. */
export function fieldAtRevision(field: string, fields: readonly string[], savedRevision: number | null, observedRevision: number,
  revisions?: Readonly<Record<string, number>>): boolean {
  return observedRevision >= (savedRevision ?? 0) && fields.includes(field) && (revisions === undefined ? savedRevision === observedRevision : Object.hasOwn(revisions, field) && revisions[field] === observedRevision);
}

/** Advance each key only from matching post-operation reads; acknowledge a revision only on full agreement. */
export async function advanceSyncBase(operations: AgreementOperations): Promise<AgreementResult> {
  const local = await operations.readLocal();
  if (local.version !== operations.expectedVersion) throw new CommandError("Local item changed before read-back agreement; re-read both trackers and retry", EXIT_CODE.conflict);
  const remote = await operations.readRemote(local);
  const previousRevisions = readBaseRevisions(local.base);
  const previousFields = new Set(baseFields(local.base));
  if (!Number.isSafeInteger(remote.revision) || remote.revision < operations.minimumRemoteRevision ||
      local.acknowledgedRevision !== undefined && remote.revision < local.acknowledgedRevision || remote.revision < Math.max(0, ...Object.values(previousRevisions))) {
    throw new CommandError("Azure read-back revision is older than the completed operation; re-read both trackers", EXIT_CODE.conflict);
  }
  const keys = [...new Set([...Object.keys(local.values), ...Object.keys(remote.values)])];
  const base: Values = {};
  const revisions: Record<string, number> = {};
  const differences: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(local.values[key]) === JSON.stringify(remote.values[key])) {
      base[key] = structuredClone(local.values[key]); revisions[key] = remote.revision;
    }
    else {
      differences.push(key);
      if (local.base !== undefined && previousFields.has(key)) {
        base[key] = structuredClone(local.base[key]);
        if (previousRevisions[key] !== undefined) revisions[key] = previousRevisions[key];
      }
    }
  }
  // A versioned partial base distinguishes unknown keys from corrupt legacy JSON.
  if (Object.keys(base).length !== keys.length) base.ado_base_partial = 1;
  base.ado_base_fields = Object.keys(base).filter((key) => key !== "ado_base_partial").sort();
  base.ado_agreed_revisions = JSON.stringify(revisions);
  await operations.publish(base, differences.length === 0 ? remote.revision : undefined, local.version);
  return { base, differences, local, remote };
}
