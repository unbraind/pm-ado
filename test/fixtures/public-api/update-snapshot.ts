/** Explicitly refresh current built declaration snapshots after reviewing API compatibility. */
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
const repo = resolve(import.meta.dirname, "../../..");
const dist = join(repo, "dist"), snapshots = join(import.meta.dirname, "current");
// This directory is dedicated to generated declaration snapshots; the published baseline stays untouched.
rmSync(snapshots, { recursive: true, force: true });
for (const entry of readdirSync(dist, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".d.ts")) continue;
  const source = join(entry.parentPath, entry.name), target = join(snapshots, `${relative(dist, source)}.txt`);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target);
}
