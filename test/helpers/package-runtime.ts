/** Copied package fixtures intentionally exclude the SDK module link. */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";

/** Copy only compiled package code and certify missing SDK resolution before testing an opaque adapter. */
export function isolatedPackage(t: TestContext, dist: string | URL): ReturnType<typeof createRequire> {
  const root = mkdtempSync(join(tmpdir(), "ado-package-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(dist, join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  const request = createRequire(join(root, "dist/index.js"));
  assert.throws(() => request.resolve("@unbrained/pm-cli/sdk"), /Cannot find module/u);
  return request;
}

/** Repository root used by real package fixture installations. */
export const packageRoot = resolve(import.meta.dirname, "../..");

/** Install the compiled project extension exactly as fixture host commands discover it. */
export function installFixtureExtension(pmRoot: string): void {
  const installed = join(pmRoot, "extensions/pm-ado");
  mkdirSync(installed, { recursive: true });
  cpSync(join(packageRoot, "dist"), join(installed, "dist"), { recursive: true });
  cpSync(join(packageRoot, "manifest.json"), join(installed, "manifest.json"));
}

/** Locate and certify a real fixture document before deliberately corrupting its storage. */
export function fixtureItemPath(pmRoot: string, id: string): string {
  const file = readdirSync(pmRoot, { recursive: true, encoding: "utf8" }).find((entry) => entry.endsWith(`/${id}.toon`));
  assert.ok(file);
  return join(pmRoot, file);
}

/** Own one temporary directory and expose cleanup so callers preserve their resource teardown order. */
export function fixtureDirectory(prefix: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
