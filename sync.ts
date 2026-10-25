/** Command orchestration and per-field Azure DevOps reconciliation. */
import { randomUUID } from "node:crypto";
import { loadResolutionSdk } from "./resolution.ts";
import type { CommandHandlerContext, FlagDefinition } from "@unbrained/pm-cli/sdk/authoring";
import type { BulkItemMutation, ItemMetadata, PmUpdateActionOptions } from "@unbrained/pm-cli/sdk";
import {
  AdoClient, CommandError, EXIT_CODE, RevisionConflict, RELATION_MAP, STATE_MAP,
  exportRelations, importRelations, missingEnv, preflightMessage, readConfig, relationTargetId,
  type AdoConfig, type AdoRelation, type AdoWorkItem, type JsonPatchOperation,
} from "./index.ts";

/** Default Azure state names mapped to local lifecycle states. */
export const IMPORT_STATE_MAP: Readonly<Record<string, string>> = {
  New: "open", Proposed: "open", "To Do": "open", Active: "in_progress",
  Committed: "in_progress", Doing: "in_progress", Blocked: "blocked",
  Resolved: "closed", Done: "closed", Closed: "closed", Removed: "closed",
};

/** Shared flags are typed by the host, which also owns JSON/TOON rendering. */
export const SYNC_FLAGS: FlagDefinition[] = [
  { long: "--dry-run", value_type: "boolean", description: "Read and plan without writing either tracker" },
  { long: "--limit", value_name: "n", value_type: "number", description: "Maximum items to process (default 100)", default: 100 },
  { long: "--wiql", value_name: "query", value_type: "string", description: "Explicit flat WIQL query for import/sync" },
  { long: "--area-path", value_name: "path", value_type: "string", description: "Import/sync: exact Azure area filter" },
  { long: "--iteration-path", value_name: "path", value_type: "string", description: "Import/sync: exact Azure iteration filter" },
  { long: "--type", value_name: "name", value_type: "string", description: "Azure work item type filter and creation type (default Task)" },
];

/** Canonical field values shared by remote, local and persisted base snapshots. */
export type Values = Record<string, string | number | string[]>;
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
  fields: Record<string, { base?: unknown; local: unknown; remote: unknown }>;
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
/** Internal plan retaining snapshots without exposing private item bodies by default. */
interface Entry {
  /** The public plan receipt. */
  plan: Plan;
  /** Existing local row when linked or exported. */
  local?: ItemMetadata;
  /** Expanded remote snapshot when linked or imported. */
  remote?: AdoWorkItem;
  /** Desired agreed canonical values. */
  values: Values;
  /** Recognized remote links to import after field operations. */
  pullRelations: boolean;
  /** Relation operations for the checked remote write. */
  operations: JsonPatchOperation[];
}

/** Compare canonical snapshots without depending on object property order. */
function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

/** Detect a field requiring an explicit decision rather than choosing either writer. */
export function threeWayFieldConflict(local: unknown, remote: unknown, base: unknown): boolean {
  return !equal(local, remote) && (base === undefined || !equal(local, base) && !equal(remote, base));
}

/** Read a string flag after the host has normalized kebab-case names. */
function option(options: Record<string, unknown>, name: string): string | undefined {
  const value = options[name] ?? options[name.replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase())];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new CommandError(`--${name} requires a non-empty string`);
  return value;
}

/** Parse an optional JSON state map and reject unusable configuration before reads. */
export function stateMap(raw: string | undefined, defaults: Readonly<Record<string, string>>): Record<string, string> {
  if (raw === undefined) return { ...defaults };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new CommandError("State map must be valid JSON"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
      Object.values(parsed).some((value) => typeof value !== "string" || !value.trim())) {
    throw new CommandError("State map must be a JSON object of non-empty strings");
  }
  return { ...defaults, ...parsed };
}

/** Escape WIQL literals; explicit WIQL cannot be combined with generated filters. */
export function buildWiql(options: Record<string, unknown>, project: string): string {
  const explicit = option(options, "wiql");
  const filters = [["System.AreaPath", option(options, "area-path")],
    ["System.IterationPath", option(options, "iteration-path")], ["System.WorkItemType", option(options, "type")]];
  if (explicit !== undefined) {
    if (filters.some(([, value]) => value !== undefined)) throw new CommandError("--wiql cannot be combined with filters");
    return explicit;
  }
  return `SELECT [System.Id] FROM WorkItems WHERE ${[["System.TeamProject", project], ...filters]
    .filter(([, value]) => value !== undefined).map(([name, value]) => `[${name}] = '${value!.replaceAll("'", "''")}'`).join(" AND ")} ORDER BY [System.Id]`;
}

/** Canonicalize tags as a set for stable reconciliation and idempotency. */
function tags(value: string[]): string[] { return [...new Set(value.map((tag) => tag.trim()).filter(Boolean))].sort(); }

/** Project Azure fields into the same normalized shape as local metadata. */
export function remoteValues(item: AdoWorkItem, mapping: Readonly<Record<string, string>>): Values {
  const fields = item.fields;
  const state = String(fields["System.State"] ?? "New");
  if (!Object.hasOwn(mapping, state)) throw new CommandError(`Unmapped Azure state: ${state}; configure ADO_STATUS_MAP`);
  const identity = fields["System.AssignedTo"];
  const assignee = typeof identity === "object" && identity !== null
    ? String((identity as Record<string, unknown>).uniqueName ?? (identity as Record<string, unknown>).displayName ?? "")
    : String(identity ?? "");
  const priority = Number(fields["Microsoft.VSTS.Common.Priority"] ?? 2);
  if (!Number.isInteger(priority) || priority < 0 || priority > 4) throw new CommandError("Azure priority must be an integer from 0 to 4");
  return {
    title: String(fields["System.Title"] ?? ""), description: String(fields["System.Description"] ?? ""),
    status: mapping[state], priority, tags: tags(String(fields["System.Tags"] ?? "").split(";").map((tag) => tag.toLowerCase())), assignee,
    ado_area_path: String(fields["System.AreaPath"] ?? ""), ado_iteration_path: String(fields["System.IterationPath"] ?? ""),
  };
}

/** Project pm fields, preserving unrelated metadata outside this mapping. */
export function localValues(item: ItemMetadata): Values {
  return { title: item.title, description: item.description ?? "", status: item.status, priority: item.priority,
    tags: tags(item.tags.map((tag) => tag.toLowerCase())), assignee: item.assignee ?? "", ado_area_path: String(item.ado_area_path ?? ""),
    ado_iteration_path: String(item.ado_iteration_path ?? "") };
}

/** Decode and validate the dedicated base; missing legacy bases never imply a winner. */
export function readBase(item: ItemMetadata, sample: Values): Values | undefined {
  if (item.ado_sync_base === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(String(item.ado_sync_base)); }
  catch { throw new CommandError(`Invalid ado_sync_base for ${item.id}: expected valid JSON`); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new CommandError("Invalid ado_sync_base");
  const base = parsed as Values;
  for (const [key, value] of Object.entries(sample)) {
    if (Array.isArray(value) ? !Array.isArray(base[key]) || (base[key] as unknown[]).some((entry) => typeof entry !== "string")
      : typeof base[key] !== typeof value) throw new CommandError(`Invalid ado_sync_base field: ${key}`);
  }
  return base;
}

/** Exact field mapping used by reconciliation and remote-contract discovery. */
export const ADO_FIELD_MAP: Readonly<Record<string, string>> = {
  title: "System.Title", description: "System.Description", status: "System.State",
  priority: "Microsoft.VSTS.Common.Priority", tags: "System.Tags", assignee: "System.AssignedTo",
  ado_area_path: "System.AreaPath", ado_iteration_path: "System.IterationPath",
};

/** Convert agreed canonical values to Azure reference names for changed fields only. */
export function azureFields(values: Values, keys: readonly string[], states: Record<string, string>): Record<string, unknown> {
  const names = ADO_FIELD_MAP;
  return Object.fromEntries(keys.filter((key) => key !== "relations").map((key) => {
    let value: unknown = values[key];
    if (key === "status") {
      if (!Object.hasOwn(states, String(value))) throw new CommandError(`Unmapped pm status: ${value}; configure ADO_EXPORT_STATE_MAP`);
      value = states[String(value)];
    }
    if (key === "tags") value = (values.tags as string[]).join("; ");
    return [names[key], value];
  }));
}

/** Convert canonical fields and provenance to one SDK mutation with a history record. */
export function pmFields(values: Values, remote: AdoWorkItem, config: AdoConfig): PmUpdateActionOptions & { field: string[] } {
  return { title: String(values.title), description: String(values.description), status: String(values.status),
    priority: Number(values.priority), tags: JSON.stringify(values.tags),
    ...(values.assignee === "" ? { unset: ["assignee"] } : { assignee: String(values.assignee) }),
    field: [`ado_id=${remote.id}`, `ado_rev=${remote.rev}`, `ado_project=${config.project}`, `ado_org_url=${config.orgUrl}`,
      `ado_url=${config.orgUrl}/_apis/wit/workItems/${remote.id}`, `ado_type=${String(remote.fields["System.WorkItemType"] ?? "Task")}`,
      `ado_area_path=${values.ado_area_path}`, `ado_iteration_path=${values.ado_iteration_path}`, `ado_sync_base=${JSON.stringify(values)}`],
    message: `Azure DevOps revision ${remote.rev}` };
}

/** Canonical recognized relations; opaque or out-of-scope links stay with the adapter. */
function relationValues(relations: readonly AdoRelation[], config: AdoConfig, identities: ReadonlyMap<number, string>): string[] {
  return tags(relations.flatMap((relation) => {
    const id = relationTargetId(relation.url, config.orgUrl);
    return Object.hasOwn(RELATION_MAP, relation.rel) && id !== undefined && identities.has(id) ? [JSON.stringify([relation.rel, id])] : [];
  }));
}

/** Compute desired remote relations from the adapter's add/remove plan. */
function applyRelations(remote: AdoWorkItem, operations: readonly JsonPatchOperation[]): AdoRelation[] {
  const result = [...remote.relations!];
  for (const operation of operations) {
    if (operation.op === "remove") result.splice(Number(operation.path.split("/").at(-1)), 1);
    else result.push(operation.value as AdoRelation);
  }
  return result;
}

/** Describe a refused revision using the client's single diagnostic snapshot. */
function revisionConflict(entry: Entry, error: RevisionConflict, config: AdoConfig, identities: ReadonlyMap<number, string>, states: Record<string, string>): Conflict {
  const current = error.current;
  const remote: Values = current === undefined ? {} : remoteValues(current, states);
  remote.relations = current === undefined ? [] : relationValues(current.relations ?? [], config, identities);
  const local: Values = { ...localValues(entry.local!), relations: entry.values.relations };
  return { pm_id: entry.local!.id, ado_id: entry.remote!.id, stored_rev: error.assertedRev, remote_rev: current?.rev ?? null,
    fields: Object.fromEntries(Object.keys(local).filter((key) => !equal(local[key], remote[key]))
      .map((key) => [key, { local: local[key], remote: remote[key] ?? null }])) };
}

/** Execute the real REST transport; failures are converted to stable command receipts. */
export async function transport(method: string, url: string, body: string | undefined, headers: Readonly<Record<string, string>>) {
  const response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(30_000) });
  return { status: response.status, body: await response.text() };
}

/** Build and apply one command plan using only the host-bound SDK client. */
export async function runSyncCommand(ctx: CommandHandlerContext, mode: "import" | "export" | "sync") {
  const plans: Plan[] = [];
  const conflicts: Conflict[] = [];
  const diagnostics: unknown[] = [];
  const dryRun = ctx.options.dryRun === true || ctx.options["dry-run"] === true;
  try {
    const config = readConfig(process.env);
    if (config === undefined) throw new CommandError(preflightMessage(ctx.command, missingEnv(process.env)));
    const pm = ctx.sdk?.client;
    if (pm === undefined) throw new CommandError("This command requires a host-bound SDK (pm CLI 2026.10.12 or newer)");
    const limit = Number(ctx.options.limit ?? 100);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new CommandError("--limit must be a positive safe integer");
    const states = stateMap(process.env.ADO_STATUS_MAP, IMPORT_STATE_MAP);
    const exportStates = stateMap(process.env.ADO_EXPORT_STATE_MAP, STATE_MAP);
    if (mode === "export" && ["wiql", "area-path", "iteration-path"].some((name) => option(ctx.options, name) !== undefined)) {
      throw new CommandError("WIQL, area and iteration filters apply to import/sync only");
    }
    const wiql = buildWiql(ctx.options, config.project);
    const client = new AdoClient(config, transport);
    const snapshot = await pm.listAllComplete();
    const { items } = snapshot;
    const snapshotReader = { listAllComplete: async () => snapshot };
    const identities = new Map<number, string>();
    for (const item of items) {
      if (item.ado_id === undefined) continue;
      if (item.ado_org_url !== undefined && item.ado_org_url !== config.orgUrl ||
          item.ado_project !== config.project) throw new CommandError(`Azure scope mismatch for ${item.id}`);
      const id = Number(item.ado_id);
      if (!Number.isSafeInteger(id) || id < 1 || identities.has(id)) throw new CommandError("ado_id must be unique positive safe integers");
      identities.set(id, item.id);
    }
    const selected = mode === "export" ? items.slice(0, limit) : [];
    const ids = mode === "export" ? selected.flatMap((item) => item.ado_id === undefined ? [] : [Number(item.ado_id)])
      : [...new Set(await client.queryIds(wiql, limit))].slice(0, limit);
    if (ids.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new CommandError("WIQL returned an invalid work item identity", EXIT_CODE.remote);
    const report = await client.getWorkItemsReport(ids);
    if (report.missing.length) throw new CommandError(`Missing work items: ${report.missing.join(", ")}`, EXIT_CODE.remote);
    for (const remote of report.items) {
      if (!ids.includes(remote.id) || !Number.isSafeInteger(remote.rev) || remote.rev < 1 ||
          typeof remote.fields !== "object" || remote.fields === null) throw new CommandError("Invalid work item response", EXIT_CODE.remote);
    }
    const remotes = new Map(report.items.map((item) => [item.id, { ...item, relations: item.relations ?? [] }]));
    const pairs: { local: ItemMetadata | undefined; remote: AdoWorkItem | undefined }[] = mode === "export" ? selected.map((local) => ({ local, remote: remotes.get(Number(local.ado_id)) }))
      : [...remotes.values()].map((remote) => ({ remote, local: items.find((item) => item.id === identities.get(remote.id)) }));
    if (mode === "sync") for (const local of items.filter((item) => item.ado_id === undefined).slice(0, limit - pairs.length)) pairs.push({ local, remote: undefined });
    const entries: Entry[] = [];
    for (const { local, remote } of pairs) {
      const plan: Plan = { pm_id: local?.id ?? null, ado_id: remote?.id ?? null, action: "none", import_fields: [], export_fields: [] };
      plans.push(plan);
      const remoteFields = remote === undefined ? undefined : remoteValues(remote, states);
      const localFields = local === undefined ? undefined : localValues(local);
      const values = { ...(remoteFields ?? localFields!) };
      const entry: Entry = { plan, local, remote, values, pullRelations: false, operations: [] };
      entries.push(entry);
      if (remote === undefined) { plan.action = "create_remote"; plan.export_fields = Object.keys(values); azureFields(values, plan.export_fields, exportStates); continue; }
      if (local === undefined) { plan.action = "create_local"; plan.import_fields = Object.keys(values); entry.pullRelations = true; continue; }
      const relationPlan = await exportRelations(remote, config.orgUrl, identities, snapshotReader);
      diagnostics.push(...relationPlan.unmapped, ...relationPlan.unmappedLocal);
      const r: Values = { ...remoteFields!, relations: relationValues(remote.relations!, config, identities) };
      const l: Values = { ...localFields!, relations: relationValues(applyRelations(remote, relationPlan.operations), config, identities) };
      const base = mode === "import" ? undefined : readBase(local, r);
      // Preserve a locally distinct status whose configured Azure representation
      // is unchanged (the default blocked and in_progress both export Active).
      if (mode !== "import" && base !== undefined && exportStates[String(base.status)] === remote.fields["System.State"]) r.status = base.status;
      const differing: Conflict["fields"] = {};
      for (const key of Object.keys(r)) {
        const remoteChanged = base === undefined || !equal(r[key], base[key]);
        if (mode === "import") { values[key] = r[key]; if (!equal(l[key], r[key])) plan.import_fields.push(key); }
        else if (mode === "export") { values[key] = l[key]; if (!equal(l[key], r[key])) plan.export_fields.push(key); }
        else if (equal(l[key], r[key])) values[key] = r[key];
        else if (threeWayFieldConflict(l[key], r[key], base?.[key])) differing[key] = { base: base?.[key], local: l[key], remote: r[key] };
        else if (remoteChanged) { values[key] = r[key]; plan.import_fields.push(key); }
        else { values[key] = l[key]; plan.export_fields.push(key); }
      }
      // The additive import adapter cannot safely erase local graph structure.
      // Refuse remote removals instead of silently resurrecting deleted links.
      if (mode === "sync" && plan.import_fields.includes("relations") &&
          (l.relations as string[]).some((value) => !(r.relations as string[]).includes(value))) {
        differing.relations = { base: base?.relations, local: l.relations, remote: r.relations };
      }
      if (Object.keys(differing).length) conflicts.push({ pm_id: local.id, ado_id: remote.id,
        stored_rev: local.ado_rev, remote_rev: remote.rev, fields: differing });
      entry.pullRelations = mode === "import" || plan.import_fields.includes("relations");
      entry.operations = plan.export_fields.includes("relations") ? relationPlan.operations : [];
      plan.action = plan.import_fields.length || plan.export_fields.length ? "reconcile" : "none";
      if (plan.export_fields.length && (!Number.isSafeInteger(local.ado_rev) || Number(local.ado_rev) < 1)) {
        throw new CommandError(`Missing valid ado_rev for ${local.id}; import first`);
      }
      if (dryRun && mode === "export" && plan.export_fields.length && local.ado_rev !== remote.rev) {
        conflicts.push(revisionConflict(entry, new RevisionConflict(remote.id, Number(local.ado_rev), remote), config, identities, states));
      }
      // Validate export mappings even in dry-run, before any write on either side.
      azureFields(values, plan.export_fields, exportStates);
    }
    if (conflicts.length) return { ok: false, code: "ADO_CONFLICT", exit_code: EXIT_CODE.conflict, dry_run: dryRun, plans, conflicts, diagnostics };
    if (!dryRun) {
      const sdk = loadResolutionSdk();
      const versions = new Map(items.map((item) => [item.id, item.updated_at]));
      /** Fence every local write against the inspected revision, including our own earlier writes. */
      const update = async (id: string, options: PmUpdateActionOptions) => {
        const transactionId = `ado-sync-${randomUUID()}`;
        // Closing via update performs two internal writes. Guard the scalar write
        // once, then let the SDK close step own its lifecycle mutation.
        const closing = options.status === "closed";
        const mutations: BulkItemMutation[] = [{ op: "update", id,
          options: closing ? { ...options, status: undefined } : options,
          match: { key: "updated_at", value: versions.get(id)! } }];
        if (closing) mutations.push({ op: "close", id, reason: options.closeReason! });
        try {
          await sdk.commitItemMutations({ pmRoot: ctx.pm_root, transactionId,
            author: ctx.global.author ?? process.env.PM_AUTHOR ?? "unknown",
            mutations });
        } catch (error) {
          if (error instanceof sdk.PmCliError && error.exitCode === EXIT_CODE.conflict) {
            throw new CommandError("Local sync persistence refused; re-read both trackers and retry. Earlier Azure or pm operations may have succeeded.", EXIT_CODE.conflict);
          }
          throw error;
        }
        // Read our own durable event, never adopt a later writer's current revision.
        const history = await sdk.readHistorySnapshot(sdk.getHistoryPath(ctx.pm_root, id), id);
        versions.set(id, history.entries.filter((entry) => entry.message?.startsWith(`bulk-item-transaction ${transactionId} `)).at(-1)!.ts);
      };
      for (const entry of entries) {
        const { plan, local, values } = entry;
        let remote = entry.remote;
        try {
          if (remote === undefined) {
            const fields = azureFields(values, plan.export_fields, exportStates);
            for (const name of ["System.AreaPath", "System.IterationPath"]) if (fields[name] === "") delete fields[name];
            // Creation has no prior revision; the server allocates identity and rev 1.
            remote = await client.createWorkItem(option(ctx.options, "type") ?? process.env.ADO_WORK_ITEM_TYPE ?? "Task", fields);
            // Creation is not idempotent: retain its identity before any later work can fail.
            plan.ado_id = remote.id;
            const field = [`ado_id=${remote.id}`, `ado_rev=${remote.rev}`, `ado_project=${config.project}`,
              `ado_org_url=${config.orgUrl}`, `ado_url=${config.orgUrl}/_apis/wit/workItems/${remote.id}`];
            await update(local!.id, { field, message: `Linked to Azure DevOps work item ${remote.id}` });
            plan.linked_fields = field.map((value) => value.slice(0, value.indexOf("=")));
            Object.assign(values, remoteValues(remote, states));
            identities.set(remote.id, local!.id);
          } else if (plan.export_fields.length) {
            remote = await client.updateWorkItem(remote.id, mode === "sync" ? remote.rev : Number(local!.ado_rev), azureFields(values, plan.export_fields, exportStates), entry.operations);
          }
        } catch (error) {
          if (!(error instanceof RevisionConflict)) throw error;
          conflicts.push(revisionConflict(entry, error, config, identities, states));
          continue;
        }
        entry.remote = { ...remote, relations: remote.relations ?? [] };
        // Persist the base only after relation import succeeds below.
        if (local === undefined) {
          const initial = pmFields(values, remote, config);
          const { item } = await pm.create({ ...initial, type: "Task", unset: undefined,
            field: initial.field.filter((field) => !field.startsWith("ado_sync_base=")) });
          entry.local = item;
          versions.set(item.id, item.updated_at);
          plan.pm_id = item.id;
          identities.set(remote.id, item.id);
        }
        plan.ado_id = remote.id;
      }
      // A 412 leaves its local item and history untouched, including inverse links.
      if (conflicts.length) return { ok: false, code: "ADO_CONFLICT", exit_code: EXIT_CODE.conflict, dry_run: false, plans, conflicts, diagnostics };
      for (const entry of entries.filter((candidate) => candidate.plan.action === "create_remote")) {
        const relationPlan = await exportRelations(entry.remote!, config.orgUrl, identities, pm);
        diagnostics.push(...relationPlan.unmapped, ...relationPlan.unmappedLocal);
        entry.values.relations = relationValues(applyRelations(entry.remote!, relationPlan.operations), config, identities);
        if (relationPlan.operations.length) {
          try { entry.remote = await client.updateWorkItem(entry.remote!.id, entry.remote!.rev, {}, relationPlan.operations); }
          catch (error) {
            if (!(error instanceof RevisionConflict)) throw error;
            conflicts.push(revisionConflict(entry, error, config, identities, states));
          }
        }
      }
      if (conflicts.length) return { ok: false, code: "ADO_CONFLICT", exit_code: EXIT_CODE.conflict, dry_run: false, plans, conflicts, diagnostics };
      const pulled = entries.filter((entry) => entry.pullRelations).map((entry) => entry.remote!);
      if (pulled.length) diagnostics.push(...(await importRelations(pulled, config.orgUrl, identities, { listAllComplete: () => pm.listAllComplete(), update })).unmapped);
      for (const entry of entries) {
        const { values, remote, local } = entry;
        values.relations = relationValues(remote!.relations!, config, identities);
        const fields = pmFields(values, remote!, config);
        if (values.status === local!.status) delete fields.status;
        if (fields.status === "closed") fields.closeReason = "Azure DevOps state synchronized";
        if (!equal(localValues(local!), Object.fromEntries(Object.entries(values).filter(([key]) => key !== "relations"))) ||
            local!.ado_rev !== remote!.rev || local!.ado_sync_base !== JSON.stringify(values)) await update(local!.id, fields);
      }
    }
    return { ok: true, dry_run: dryRun, plans, conflicts, diagnostics };
  } catch (error) {
    const exitCode = error instanceof CommandError ? error.exitCode : EXIT_CODE.remote;
    return { ok: false, code: exitCode === EXIT_CODE.usage ? "ADO_USAGE" : exitCode === EXIT_CODE.conflict ? "ADO_CONFLICT" : "ADO_REMOTE",
      exit_code: exitCode, dry_run: dryRun, plans, conflicts, diagnostics,
      error: error instanceof CommandError ? error.message : "Azure DevOps command failed; check configuration, tracker validity and connectivity" };
  }
}
