/** Read-only Azure project metadata discovery; this module never plans or applies writes. */
import { createHash } from "node:crypto";
import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import type { ItemMetadata, SchemaListResult } from "@unbrained/pm-cli/sdk";
import { EXIT_CODE, RELATION_MAP, STATE_MAP, type AdoConfig, type AdoTransport } from "./index.ts";
import { ADO_FIELD_MAP, IMPORT_STATE_MAP, azureFields, localValues, stateMap, transport } from "./sync.ts";

/** Stable refusal vocabulary for SDK callers and host-rendered CLI results. */
export type ContractRefusalCode = "configuration" | "permission_denied" | "not_found" | "remote_failure" | "invalid_schema" | "schema_changed";

/** An actionable failure that contains no remote response body or credentials. */
export class ContractRefusal extends Error {
  /** Semantic shell exit used by the host command runtime. */
  readonly exitCode: number;
  /** Machine-readable reason for refusing discovery. */
  readonly code: ContractRefusalCode;
  /** Specific next step for the caller. */
  readonly remedy: string;
  /** Record a stable refusal code and remedy without exposing server details. */
  constructor(code: ContractRefusalCode, remedy: string, exitCode: number = EXIT_CODE.remote) {
    super(`Azure contract discovery refused: ${code}`);
    this.name = "ContractRefusal";
    this.exitCode = exitCode;
    this.code = code;
    this.remedy = remedy;
  }
}

/** Per-type metadata, normalized independently of friendly names and REST URLs. */
export interface ContractField {
  /** Stable Azure reference name. */
  ref: string;
  /** Azure field data type, retained for custom process fields. */
  type: string;
  /** False when Azure marks the field read-only; not an effective ACL check. */
  writable: boolean;
  /** Unconditional required-value metadata for this work item type. */
  required: boolean;
  /** Allowed metadata values, empty when Azure provides no enumeration. */
  allowed: unknown[];
  /** Process default, or null when absent. */
  default: unknown;
  /** Reference names participating in conditional field rules. */
  depends_on: string[];
}

/** A mapping incompatibility; counts aggregate tracker checks without item bodies. */
export interface ContractIssue {
  /** Stable machine-readable incompatibility code. */
  code: "missing_field" | "read_only" | "field_type" | "required_unmapped" | "export_state" | "import_state" | "relation_unavailable" | "item_type" | "item_value";
  /** Affected type, state, field or relation reference. */
  target: string;
  /** Occurrences aggregated across the checked snapshot. */
  count: number;
  /** Action needed before planning sync. */
  remedy: string;
}

/** Type availability and the fields/states an explicitly selected project exposes. */
export interface ContractType {
  /** Azure work item type name, including custom types. */
  name: string;
  /** Whether Azure disables this type. */
  disabled: boolean;
  /** State names exposed by this project type. */
  states: string[];
  /** Complete normalized field metadata for this type. */
  fields: ContractField[];
}

/** Organization-level relation capabilities; these flags do not establish caller ACLs. */
export interface ContractRelation {
  /** Stable Azure reference name. */
  ref: string;
  /** Relation capability flag, or null when not supplied. */
  enabled: boolean | null;
  /** Relation metadata flag, not a caller permission grant. */
  editable: boolean | null;
  /** Azure relation usage, or null when unspecified. */
  usage: string | null;
  /** Existing pm relation semantic, or null for unmapped custom types. */
  mapped: string | null;
}

/** Agent-readable result; successful discovery is distinct from mapping compatibility. */
export interface ProjectContract {
  /** Discovery succeeded; compatibility and permissions remain separate. */
  ok: true;
  /** Always true: discovery never writes either tracker. */
  preview: true;
  /** Explicit project selected by the caller. */
  project: string;
  /** SHA-256 over normalized remote metadata and scope. */
  fingerprint: string;
  /** No known incompatibilities found; does not certify permissions. */
  compatible: boolean;
  /** Read access observed; effective write access remains unknown. */
  permissions: { metadata_read: "allowed"; field_write: "unknown"; relation_write: "unknown"; remedy: string };
  /** Selected work item types, sorted by name. */
  types: ContractType[];
  /** Organization relation capabilities, sorted by reference name. */
  relations: ContractRelation[];
  /** Known mapping incompatibilities with actionable remedies. */
  issues: ContractIssue[];
  /** Number of complete SDK snapshot items checked. */
  checked_items: number;
}

/** Optional type filter, schema pin, configured maps and complete SDK tracker snapshot. */
export interface ContractOptions {
  /** Optional work item type name; omit to inspect every project type. */
  type?: string;
  /** Refuse discovery if the normalized remote schema differs. */
  expectedFingerprint?: string;
  /** Local schema status IDs from the SDK, when tracker compatibility is checked. */
  localStatuses?: readonly string[];
  /** Existing local-to-Azure state overrides. */
  exportStates?: Readonly<Record<string, string>>;
  /** Existing Azure-to-local state overrides. */
  importStates?: Readonly<Record<string, string>>;
  /** Optional complete local snapshot supplied by the host SDK. */
  items?: readonly ItemMetadata[];
}

/** Fail closed when remote metadata no longer has the documented shape. */
function schema(condition: unknown): asserts condition {
  if (!condition) throw new ContractRefusal("invalid_schema", "Refresh discovery against Azure REST 7.1; inspect changed metadata before planning sync.");
}

/** Narrow JSON objects before reading any server-controlled property. */
function record(value: unknown): Record<string, unknown> {
  schema(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

/** Require a nonempty metadata identifier without interpreting it as a URL. */
function name(value: unknown): string {
  schema(typeof value === "string" && value.trim().length > 0);
  return value;
}

/** Validate optional REST booleans instead of silently treating changed types as false. */
function flag(value: unknown): boolean | null {
  schema(value === undefined || typeof value === "boolean");
  return value === undefined ? null : value;
}

/** Parse arrays of metadata objects and refuse duplicate identifiers. */
function rows(value: unknown, key: string): Record<string, unknown>[] {
  schema(Array.isArray(value));
  const result = value.map(record);
  const keys = result.map((row) => name(row[key]));
  schema(new Set(keys).size === keys.length);
  return result;
}

/** Sort JSON recursively so schema fingerprints survive server ordering changes. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}

/**
 * Discover project WIT metadata using GET only, without an SDK mutation or git dependency.
 * Metadata cannot prove effective edit/link permissions or conditional process rules.
 * A schema fingerprint covers selected remote metadata, excluding tracker contents and maps.
 */
export async function discoverProjectContract(config: AdoConfig, request: AdoTransport, options: ContractOptions = {}): Promise<ProjectContract> {
  let org: URL;
  try { org = new URL(config.orgUrl); }
  catch { throw new ContractRefusal("configuration", "Set ADO_ORG_URL to an absolute HTTPS organization URL.", EXIT_CODE.usage); }
  if ((org.protocol !== "https:" && !(org.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(org.hostname))) || org.username || org.password || org.search || org.hash ||
      !config.project.trim() || [".", ".."].includes(config.project) || !config.token.trim() ||
      (options.type !== undefined && (!options.type.trim() || [".", ".."].includes(options.type)))) {
    throw new ContractRefusal("configuration", "Select a nonempty project/type, a token with Work Items read, and a credential-free HTTPS organization URL.", EXIT_CODE.usage);
  }
  const base = config.orgUrl.replace(/\/+$/u, "");
  const project = `${base}/${encodeURIComponent(config.project)}`;
  /** Read a fixed REST endpoint, refusing redirects and suppressing remote secrets. */
  const get = async (root: string, path: string): Promise<Record<string, unknown>[]> => {
    let response: Awaited<ReturnType<AdoTransport>>;
    try { response = await request("GET", `${root}/_apis/wit/${path}api-version=7.1`, undefined, { Accept: "application/json", Authorization: `Basic ${Buffer.from(`:${config.token}`).toString("base64")}` }); }
    catch { throw new ContractRefusal("remote_failure", "Check Azure reachability and retry discovery; no writes were attempted."); }
    if (response.status === 401 || response.status === 403) throw new ContractRefusal("permission_denied", "Grant Work Items read (vso.work) and project visibility; retry discovery with that identity.");
    if (response.status === 404) throw new ContractRefusal("not_found", "Verify the selected organization, project and type are visible to this identity.");
    if (response.status < 200 || response.status >= 300) throw new ContractRefusal("remote_failure", "Check Azure service availability and retry discovery; no writes were attempted.");
    let data: unknown;
    try { data = JSON.parse(response.body); }
    catch { throw new ContractRefusal("invalid_schema", "Expected REST 7.1 JSON metadata; check the endpoint and retry."); }
    const envelope = record(data);
    const result = rows(envelope.value, "referenceName");
    // A truncated metadata list must never masquerade as a complete contract.
    schema(envelope.count === result.length);
    return result;
  };
  const definitions = await get(project, "fields?");
  for (const field of definitions) { name(field.type); schema(typeof field.readOnly === "boolean"); }
  const byRef = new Map(definitions.map((field) => [String(field.referenceName), field]));
  const remoteTypes = await get(project, "workitemtypes?");
  const selected = remoteTypes.filter((type) => options.type === undefined || type.name === options.type);
  if (selected.length === 0) throw new ContractRefusal("not_found", "Choose a work item type returned by discovery for this project.");
  const types: ContractType[] = [];
  for (const type of selected) {
    const typeName = name(type.name);
    const fields = await get(project, `workitemtypes/${encodeURIComponent(typeName)}/fields?$expand=all&`);
    const normalized = fields.map((field): ContractField => {
      const ref = String(field.referenceName);
      const definition = byRef.get(ref);
      schema(definition !== undefined);
      schema(typeof field.alwaysRequired === "boolean");
      schema(field.allowedValues === undefined || Array.isArray(field.allowedValues));
      return { ref, type: String(definition.type), writable: !definition.readOnly, required: field.alwaysRequired,
        allowed: (field.allowedValues ?? []) as unknown[], default: field.defaultValue ?? null,
        depends_on: rows(field.dependentFields ?? [], "referenceName").map((entry) => String(entry.referenceName)).sort() };
    }).sort((a, b) => a.ref.localeCompare(b.ref));
    types.push({ name: typeName, disabled: flag(type.isDisabled) === true,
      states: rows(type.states, "name").map((state) => String(state.name)).sort(), fields: normalized });
  }
  types.sort((a, b) => a.name.localeCompare(b.name));
  const relations = (await get(base, "workitemrelationtypes?")).map((row): ContractRelation => {
    const attributes = record(row.attributes);
    const ref = String(row.referenceName);
    schema(attributes.usage === undefined || typeof attributes.usage === "string");
    return { ref, enabled: flag(attributes.enabled), editable: flag(attributes.editable), usage: (attributes.usage as string | undefined) ?? null,
      mapped: Object.hasOwn(RELATION_MAP, ref) ? RELATION_MAP[ref] : null };
  }).sort((a, b) => a.ref.localeCompare(b.ref));
  const fingerprint = createHash("sha256").update(JSON.stringify(canonical({ organization: base, project: config.project, types, relations }))).digest("hex");
  if (options.expectedFingerprint !== undefined && options.expectedFingerprint !== fingerprint) throw new ContractRefusal("schema_changed", "Re-read the project contract and review mapping changes before planning sync.", EXIT_CODE.conflict);
  const issues: ContractIssue[] = [];
  /** Aggregate identical diagnostics without copying tracker bodies or identities. */
  const issue = (code: ContractIssue["code"], target: string, remedy: string) => {
    const previous = issues.find((entry) => entry.code === code && entry.target === target);
    if (previous) previous.count++;
    else issues.push({ code, target, count: 1, remedy });
  };
  const exportStates = options.exportStates ?? STATE_MAP;
  const importStates = options.importStates ?? IMPORT_STATE_MAP;
  for (const type of types) {
    if (type.disabled) issue("item_type", type.name, "Select an enabled Azure work item type.");
    for (const [local, ref] of Object.entries(ADO_FIELD_MAP)) {
      const field = type.fields.find((entry) => entry.ref === ref);
      const target = `${type.name}/${ref}`;
      if (!field) { issue("missing_field", target, "Select a type exposing this sync field or extend the adapter mapping."); continue; }
      if (!field.writable) issue("read_only", target, "Exclude this field from writes or change the Azure process before exporting.");
      const expected = local === "priority" ? ["integer"] : ["string", "html", "plainText", "treePath"];
      if (!expected.includes(field.type)) issue("field_type", target, "Review the remote field type and the adapter conversion before exporting.");
    }
    for (const field of type.fields) {
      if (field.writable && field.required && field.default === null && !Object.values(ADO_FIELD_MAP).includes(field.ref)) issue("required_unmapped", `${type.name}/${field.ref}`, "Supply a process default or add an explicit adapter mapping for this required field.");
    }
    for (const [status, state] of Object.entries(exportStates)) if (!type.states.includes(state)) issue("export_state", `${type.name}/${status}`, "Configure ADO_EXPORT_STATE_MAP with a state exposed by this type.");
    for (const state of type.states) if (!Object.hasOwn(importStates, state) || (options.localStatuses !== undefined && !options.localStatuses.includes(importStates[state]))) issue("import_state", `${type.name}/${state}`, "Configure ADO_STATUS_MAP for this Azure state using a status in the local SDK schema.");
  }
  for (const ref of Object.keys(RELATION_MAP)) {
    const relation = relations.find((entry) => entry.ref === ref);
    if (!relation || relation.enabled !== true || relation.editable !== true || relation.usage !== "workItemLink") issue("relation_unavailable", ref, "Review enabled/editable workItemLink metadata and project link permissions before exporting relations.");
  }
  const items = options.items ?? [];
  for (const item of items) {
    const typeName = String(item.ado_type ?? options.type ?? "Task");
    const type = types.find((entry) => entry.name === typeName && !entry.disabled);
    if (!type) { issue("item_type", typeName, "Select or map an enabled Azure type for these tracker items."); continue; }
    if (!Object.hasOwn(exportStates, item.status)) { issue("export_state", `${typeName}/${item.status}`, "Configure ADO_EXPORT_STATE_MAP for this local status."); continue; }
    const values = azureFields(localValues(item), Object.keys(ADO_FIELD_MAP), exportStates);
    for (const field of type.fields) {
      if (!Object.hasOwn(values, field.ref)) continue;
      const value = values[field.ref];
      if ((field.required && value === "" && field.default === null) || (field.allowed.length > 0 && !field.allowed.some((allowed) => JSON.stringify(allowed) === JSON.stringify(value)))) issue("item_value", `${typeName}/${field.ref}`, "Provide a required/allowed value through the existing mapping before planning export.");
    }
  }
  return { ok: true, preview: true, project: config.project, fingerprint, compatible: issues.length === 0,
    permissions: { metadata_read: "allowed", field_write: "unknown", relation_write: "unknown", remedy: "Have a project administrator verify effective edit/link ACLs and conditional process rules. Metadata discovery does not authorize writes." },
    types, relations, issues, checked_items: items.length };
}

/** Run through the host SDK and renderer; failures carry stable codes and shell exits. */
export async function runContractCommand(ctx: CommandHandlerContext) {
  try {
    const project = ctx.options.project;
    if (typeof project !== "string" || !project.trim() || !process.env.ADO_ORG_URL?.trim() || !process.env.ADO_TOKEN?.trim()) throw new ContractRefusal("configuration", "Pass --project explicitly and set ADO_ORG_URL plus ADO_TOKEN with Work Items read.", EXIT_CODE.usage);
    const type = ctx.options.type;
    const expected = ctx.options.expectFingerprint ?? ctx.options["expect-fingerprint"];
    if ((type !== undefined && typeof type !== "string") || (expected !== undefined && (typeof expected !== "string" || !/^[a-f0-9]{64}$/u.test(expected)))) throw new ContractRefusal("configuration", "Pass a type name and a 64-character SHA-256 --expect-fingerprint.", EXIT_CODE.usage);
    const checkTracker = ctx.options.checkTracker === true || ctx.options["check-tracker"] === true;
    const pm = ctx.sdk?.client;
    if (checkTracker && pm === undefined) throw new ContractRefusal("configuration", "Use a host-bound pm SDK to read the complete tracker, or omit --check-tracker.", EXIT_CODE.usage);
    const localSchema = checkTracker ? await pm!.schema("list") as SchemaListResult : undefined;
    return await discoverProjectContract({ orgUrl: process.env.ADO_ORG_URL.trim(), project: project.trim(), token: process.env.ADO_TOKEN.trim() }, transport,
      { type, expectedFingerprint: expected, localStatuses: localSchema ? [...localSchema.statuses.builtin, ...localSchema.statuses.custom].map((status) => status.id) : undefined, exportStates: stateMap(process.env.ADO_EXPORT_STATE_MAP, STATE_MAP), importStates: stateMap(process.env.ADO_STATUS_MAP, IMPORT_STATE_MAP),
        items: checkTracker ? (await pm!.listAllComplete()).items : undefined });
  } catch (error) {
    const refusal = error instanceof ContractRefusal ? error : new ContractRefusal("configuration", "Check state-map JSON and the complete SDK tracker read before retrying.", EXIT_CODE.usage);
    process.exitCode = refusal.exitCode;
    return { ok: false, preview: true, code: refusal.code, remedy: refusal.remedy, exit_code: refusal.exitCode };
  }
}
