/** Exact authoritative-file hashes for read-only integration probes. */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * True when the joined entry lives inside the derived runtime cache tree.
 *
 * `join` emits the platform separator, so the boundary must match either
 * separator convention: a Windows journal of `...\runtime\cache\x` must be
 * excluded exactly like `.../runtime/cache/x` on POSIX.
 *
 * @param pmRoot - Absolute tracker root whose `runtime` subtree is derived.
 * @param entry - Joined recursive entry path below that root.
 * @returns Whether the entry is a derived runtime cache file.
 */
export function isRuntimeCacheEntry(pmRoot: string, entry: string): boolean {
  const base = `${pmRoot.replaceAll("\\", "/")}/runtime`;
  const normalized = entry.replaceAll("\\", "/");
  return normalized === base || normalized.startsWith(`${base}/`);
}

/** Retain every regular tracked document and history file while excluding derived runtime caches. */
export function authoritativeDigest(pmRoot: string): Record<string, string> {
  return Object.fromEntries(readdirSync(pmRoot, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && !isRuntimeCacheEntry(pmRoot, join(entry.parentPath, entry.name))).map((entry) => {
    const path = join(entry.parentPath, entry.name);
    return [path.slice(pmRoot.length), createHash("sha256").update(readFileSync(path)).digest("hex")];
  }));
}
