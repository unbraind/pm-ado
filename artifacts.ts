/** Read-only delivery evidence at the Azure work-item revisions observed in one batch. */
import type { PmClient } from "@unbrained/pm-cli/sdk";
import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import { AdoClient, EXIT_CODE, readConfig, type AdoConfig, type AdoTransport, type AdoWorkItem } from "./index.ts";
import { normalizeScopeValue, sameScope } from "./normalization.ts";

/** Maximum selected items and distinct links returned for each item. */
export const ARTIFACT_LIMITS = { items: 20, linksPerItem: 10 } as const;

type BuildKind = "build" | "found_in_build" | "integrated_in_build";

/** Whitelisted coordinates extracted from a work item ArtifactLink. */
export type ArtifactLink =
  | { kind: "pull_request"; project_id: string; repository_id: string; id: number }
  | { kind: BuildKind; id: number };

/** One requested PM identity, including evidence gaps for its Azure work item. */
export interface ArtifactRow {
  /** Canonical PM ID and scoped Azure work item ID. */
  pm_id: string;
  ado_id: number;
  /** Observed Azure revision, or null when Azure omitted the requested item. */
  rev: number | null;
  /** Distinct recognized links, ordered by kind and canonical coordinates. */
  links: ArtifactLink[];
  /** Counts of recognized links beyond the cap and out-of-scope or malformed references. */
  omitted_links: number;
  unsupported_links: number;
  invalid_links: number;
}

/** Successful read-only plan. Inspect complete before drawing conclusions from absence. */
export interface ArtifactPlan {
  ok: true;
  complete: boolean;
  rows: ArtifactRow[];
}

/** Stable failures shared by the CLI and SDK. */
export type ArtifactRefusalCode = "configuration" | "selection" | "read_failure";

const remedies = {
  configuration: "Use an initialized pm tracker and configure ADO_ORG_URL, ADO_PROJECT and a Work Items read token.",
  selection: "Select 1..20 distinct exact pm IDs with unique Azure links in the configured organization and project.",
  read_failure: "Check tracker health and Azure Work Items read access, then request a fresh plan.",
};

/** Refuse invalid or ambiguous evidence without exposing request details. */
export class ArtifactRefusal extends Error {
  /** Machine-readable failure category. */
  readonly code: ArtifactRefusalCode;

  /** Shell exit forwarded by the host: 2 for input and 3 for read failure. */
  readonly exitCode: number;

  /** Capture a stable refusal code and operator remedy. */
  constructor(code: ArtifactRefusalCode) {
    super(remedies[code]);
    this.name = "ArtifactRefusal";
    this.code = code;
    this.exitCode = code === "read_failure" ? EXIT_CODE.remote : EXIT_CODE.usage;
  }
}

const pullPrefix = "vstfs:///Git/PullRequestId/";
const buildPrefix = "vstfs:///Build/Build/";
const guid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const pullCoordinates = new RegExp(`^(${guid})(?:/|%2f)(${guid})(?:/|%2f)([1-9][0-9]{0,9})$`, "iu");
const buildCoordinates = /^[1-9][0-9]{0,9}$/u;
const buildKinds = new Map<unknown, BuildKind>([
  ["Found in build", "found_in_build"],
  ["Integrated in build", "integrated_in_build"],
]);

/** Azure DevOps uses positive signed 32-bit integers for these coordinates. */
function positiveId(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 2_147_483_647;
}

/** Compare canonical strings without locale-dependent ordering. */
function compare(left: string, right: string): number {
  return left < right ? -1 : Number(left > right);
}

/** Extract supported coordinates only. Undefined is unsupported; null is malformed. */
function readLink(url: unknown, name: unknown): ArtifactLink | undefined | null {
  if (typeof url !== "string") return null;
  if (url.startsWith(pullPrefix)) {
    const match = pullCoordinates.exec(url.slice(pullPrefix.length));
    const id = Number(match?.[3]);
    if (!match || !positiveId(id)) return null;
    return { kind: "pull_request", project_id: match[1]!.toLowerCase(), repository_id: match[2]!.toLowerCase(), id };
  }
  if (url.startsWith(buildPrefix)) {
    const coordinates = url.slice(buildPrefix.length);
    const id = Number(coordinates);
    if (!buildCoordinates.test(coordinates) || !positiveId(id)) return null;
    const kind = buildKinds.get(name) ?? "build";
    return { kind, id };
  }
  return undefined;
}

/** Inventory a single observation, counting unknown evidence without copying raw attributes. */
function inventory(pm_id: string, ado_id: number, item: AdoWorkItem | undefined): ArtifactRow {
  const links = new Map<string, ArtifactLink>();
  let unsupported_links = 0, invalid_links = 0;
  for (const relation of item?.relations ?? []) {
    if (typeof relation?.rel !== "string") {
      invalid_links++;
      continue;
    }
    if (relation.rel !== "ArtifactLink") continue;
    const link = readLink(relation.url, relation.attributes?.name);
    if (link === undefined) unsupported_links++;
    else if (link === null) invalid_links++;
    else {
      const coordinates = link.kind === "pull_request" ? `/${link.project_id}/${link.repository_id}` : "";
      links.set(`${link.kind}${coordinates}/${String(link.id).padStart(10, "0")}`, link);
    }
  }
  const sorted = [...links.keys()].sort(compare);
  return { pm_id, ado_id, rev: item?.rev ?? null,
    links: sorted.slice(0, ARTIFACT_LIMITS.linksPerItem).map((key) => links.get(key)!),
    omitted_links: Math.max(0, sorted.length - ARTIFACT_LIMITS.linksPerItem), unsupported_links, invalid_links };
}

/**
 * Observe explicit imported identities through a complete, host-bound SDK read.
 * One Azure relation batch supplies the evidence. The function writes neither tracker
 * and never follows an artifact URL or resolves Git/Pipelines status.
 */
export async function observeArtifactPlan(pm: Pick<PmClient, "listAllComplete">, config: AdoConfig,
  request: AdoTransport, ids: readonly string[]): Promise<ArtifactPlan> {
  if (ids.length === 0 || ids.length > ARTIFACT_LIMITS.items || new Set(ids).size !== ids.length || ids.includes("")) {
    throw new ArtifactRefusal("selection");
  }
  try {
    const selected = new Map<string, number>();
    const matches = new Map<number, number>();
    const { items } = await pm.listAllComplete();
    const requested = new Set(ids);
    for (const item of items) {
      if (!sameScope(item, config, "refuse") || !positiveId(item.ado_id)) continue;
      matches.set(item.ado_id, (matches.get(item.ado_id) ?? 0) + 1);
      if (requested.has(item.id)) selected.set(item.id, item.ado_id);
    }
    const remoteIds = [...selected.values()];
    if (selected.size !== ids.length || remoteIds.some((id) => matches.get(id) !== 1)) throw new ArtifactRefusal("selection");

    const project = normalizeScopeValue(config.project);
    const client = new AdoClient({ ...config, orgUrl: normalizeScopeValue(config.orgUrl, true), project }, request);
    const batch = await client.getWorkItemsReport(remoteIds.sort((left, right) => left - right), { relations: true });
    const remote = new Map<number, AdoWorkItem>();
    for (const item of batch.items) {
      if (!remoteIds.includes(item.id) || remote.has(item.id) || !positiveId(item.rev) ||
        item.fields?.["System.TeamProject"] !== project ||
        (item.relations !== undefined && !Array.isArray(item.relations))) {
        throw new ArtifactRefusal("read_failure");
      }
      remote.set(item.id, item);
    }

    const rows = [...selected.keys()].sort(compare).map((id) => {
      const adoId = selected.get(id)!;
      return inventory(id, adoId, remote.get(adoId));
    });
    const complete = rows.every((row) => row.rev !== null && !row.invalid_links && !row.unsupported_links && !row.omitted_links);
    return { ok: true, complete, rows };
  } catch (error) {
    if (error instanceof ArtifactRefusal) throw error;
    throw new ArtifactRefusal("read_failure");
  }
}

/** One timeout-bound request to the configured Work Items endpoint. */
async function artifactTransport(method: string, url: string, body: string | undefined, headers: Readonly<Record<string, string>>) {
  const response = await fetch(url, { method, body, headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
  return { status: response.status, body: await response.text() };
}

/** Run the preview through the host SDK and let the host render JSON or TOON. */
export async function runArtifactCommand(ctx: CommandHandlerContext) {
  try {
    const config = readConfig(process.env);
    const ids = ctx.options.items;
    if (!config || !ctx.sdk?.client || typeof ids !== "string") throw new ArtifactRefusal("configuration");
    return await observeArtifactPlan(ctx.sdk.client, config, artifactTransport, ids.split(",").map((id) => id.trim()));
  } catch (error) {
    const refusal = error as ArtifactRefusal;
    process.exitCode = refusal.exitCode;
    return { ok: false, code: refusal.code, remedy: refusal.message, exit_code: refusal.exitCode };
  }
}
