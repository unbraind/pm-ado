/** Azure relation operation semantics shared by independent fixture transports. */
import type { AdoRelation, JsonPatchOperation } from "../../index.ts";

/** Apply one fixture relation operation; field updates remain the caller's responsibility. */
export function applyFixtureRelation(relations: AdoRelation[], operation: JsonPatchOperation): boolean {
  if (operation.path === "/relations/-") relations.push(operation.value as AdoRelation);
  else if (operation.op === "remove") relations.splice(Number(operation.path.split("/").at(-1)), 1);
  else return false;
  return true;
}
