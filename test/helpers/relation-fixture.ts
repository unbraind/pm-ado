/** Azure relation operation semantics shared by independent fixture transports. */
import type { AdoRelation, JsonPatchOperation } from "../../index.ts";

/** Apply one fixture relation operation; field updates remain the caller's responsibility. */
export function applyFixtureRelation(relations: AdoRelation[], operation: JsonPatchOperation): boolean {
  // Only a genuine append may grow the list; other ops on the append path stay with the caller.
  if (operation.op === "add" && operation.path === "/relations/-") relations.push(operation.value as AdoRelation);
  // Removals are valid only on a real in-range relation index; anything else stays with the caller.
  else if (operation.op === "remove" && /^\/relations\/(0|[1-9][0-9]*)$/u.test(operation.path)) {
    const index = Number(operation.path.split("/").at(-1));
    if (index >= relations.length) return false;
    relations.splice(index, 1);
  }
  else return false;
  return true;
}
