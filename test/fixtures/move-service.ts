/** Synthetic REST project with inherited ACLs and a conditional iteration rule; never persists PATCH. */
import assert from "node:assert/strict";
import type { AdoConfig, AdoTransport, AdoWorkItem, JsonPatchOperation } from "../../index.ts";

/** Create a minimal complete classification work item for service validation. */
export function moveItem(id: number, fields: Record<string, unknown> = {}): AdoWorkItem {
  return { id, rev: 7, fields: { "System.TeamProject": "Example", "System.WorkItemType": "Task", "System.AreaPath": "Example\\Old", "System.IterationPath": "Example\\Old Sprint", "Custom.Ready": true, ...fields }, relations: [] };
}
/** A REST test double, distinct from the real pm SDK used by every tracker test. */
export function moveService(initial: AdoWorkItem[] = [moveItem(1)]) {
  const config: AdoConfig = { orgUrl: "https://dev.azure.com/example", project: "Example", token: "synthetic-move-token" };
  const items = new Map(initial.map((item) => [item.id, structuredClone(item)]));
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fields = ["System.AreaPath", "System.IterationPath"].map((referenceName) => ({ referenceName, type: "treePath", readOnly: false }));
  const typeFields = fields.map((field) => ({ referenceName: field.referenceName, alwaysRequired: true, allowedValues: [] as string[] }));
  const types = [{ name: "Task", referenceName: "Example.Task", isDisabled: false, states: [{ name: "New" }] }];
  const overrides = new Map<string, { status: number; body: string }>();
  const deniedAreas = new Set<string>();
  let batchTransform = (value: AdoWorkItem[]): unknown => value;
  /** Match ancestor paths; an inherited deny wins over destination visibility. */
  const denied = (path: string) => [...deniedAreas].some((ancestor) => path === ancestor || path.startsWith(`${ancestor}\\`));
  /** Expose exactly the contract, read-only batch and non-saving validation endpoints. */
  const request: AdoTransport = async (method, raw, body, headers) => {
    const url = new URL(raw);
    const path = url.pathname.split("/_apis/wit/")[1]!;
    const data = body === undefined ? undefined : JSON.parse(body) as Record<string, unknown> & JsonPatchOperation[];
    calls.push({ method, url: raw, body: data });
    assert.equal(headers.Authorization, `Basic ${Buffer.from(`:${config.token}`).toString("base64")}`);
    const override = overrides.get(method === "PATCH" ? `patch:${path.split("/").at(-1)}` : path);
    if (override) return override;
    /** Encode one sanitized fixture response. */
    const response = (status: number, value: unknown) => ({ status, body: JSON.stringify(value) });
    if (method === "GET") {
      const value = path === "fields" ? fields : path === "workitemtypes" ? types : path === "workitemrelationtypes" ? [] : typeFields;
      return response(200, { count: value.length, value });
    }
    if (path === "workitemsbatch") {
      assert.equal(method, "POST"); assert.equal(data!.$expand, "relations");
      const value = (data!.ids as number[]).flatMap((id) => items.has(id) ? [items.get(id)!] : []);
      return response(200, { count: value.length, value: batchTransform(value) });
    }
    assert.equal(method, "PATCH"); assert.equal(url.searchParams.get("validateOnly"), "true");
    assert.equal(url.searchParams.get("bypassRules"), "false");
    assert.equal(headers["Content-Type"], "application/json-patch+json");
    const current = items.get(Number(path.split("/").at(-1)))!;
    assert.equal(data![0]!.op, "test"); assert.equal(data![0]!.path, "/rev");
    if (data![0]!.value !== current.rev) return response(412, {});
    const proposed = structuredClone(current);
    for (const op of data!.slice(1)) {
      assert.ok(["/fields/System.AreaPath", "/fields/System.IterationPath"].includes(op.path));
      proposed.fields[op.path.slice(8)] = op.value;
    }
    if (denied(String(current.fields["System.AreaPath"])) || denied(String(proposed.fields["System.AreaPath"]))) return response(403, { message: "server-secret inherited deny" });
    if (String(proposed.fields["System.IterationPath"]).endsWith("\\Release") && !proposed.fields["Custom.Ready"]) return response(400, { message: "server-secret conditional iteration rule" });
    return response(200, proposed);
  };
  return { config, request, items, calls, fields, typeFields, types, overrides, deniedAreas, transformBatch: (fn: typeof batchTransform) => { batchTransform = fn; } };
}
