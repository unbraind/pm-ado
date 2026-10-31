/** Exact authoritative-file hashes for read-only integration probes. */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Retain every regular tracked document and history file while excluding derived runtime caches. */
export function authoritativeDigest(pmRoot: string): Record<string, string> {
  return Object.fromEntries(readdirSync(pmRoot, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && !join(entry.parentPath, entry.name).includes(`${join(pmRoot, "runtime")}/`)).map((entry) => {
    const path = join(entry.parentPath, entry.name);
    return [path.slice(pmRoot.length), createHash("sha256").update(readFileSync(path)).digest("hex")];
  }));
}
