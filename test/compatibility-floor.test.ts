import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

interface PackageManifest {
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

interface ExtensionManifest {
  /**
   * Declared as `unknown` deliberately: `manifest.json` is untrusted JSON, and
   * typing this `string | undefined` would assert the very shape these tests
   * exist to verify. Each test narrows it explicitly before use, so a manifest
   * carrying a number, an object, or nothing at all fails with a message that
   * names the actual type rather than being coerced into a plausible string.
   */
  readonly pm_min_version?: unknown;
}

const packageJson = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
) as PackageManifest;
const extensionManifest = JSON.parse(
  readFileSync(resolve(repoRoot, "manifest.json"), "utf8"),
) as ExtensionManifest;

const CLI = "@unbrained/pm-cli";
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * Two independent systems enforce the pm CLI compatibility floor, and each reads
 * a different declaration.
 *
 * `npm` enforces `peerDependencies["@unbrained/pm-cli"]` at install time, and it
 * never sees a globally installed host CLI. The pm CLI itself enforces the
 * top-level `pm_min_version` in `manifest.json` — it refuses to install or
 * activate an extension whose floor exceeds the running CLI, and reports
 * `extension_pm_min_version_unmet` from `pm health`. Neither reads the other's
 * field, and a floor written into a field nothing reads is silently inert.
 *
 * These tests bind the two declarations to the same version so that whichever
 * enforcement path a consumer takes, it applies the same floor.
 */
/**
 * Whether `pinned` is the same version as `floor` or a later one.
 *
 * Fleet versions are `YYYY.M.D` with unpadded month and day, so a
 * lexicographic comparison is wrong in a way that reads as correct:
 * `"2026.8.15" < "2026.8.7"` is `true` as strings. Each component is therefore
 * compared as a number, at the first position where the two differ.
 *
 * Both arguments must already match {@link EXACT_VERSION}; the callers assert
 * that first, so no part can be `NaN` here.
 *
 * @param pinned - The exact version pinned in `devDependencies`.
 * @param floor - The exact version declared as the compatibility floor.
 * @returns `true` when `pinned` is at or above `floor`.
 */
function atOrAbove(pinned: string, floor: string): boolean {
  const floorParts = floor.split(".").map(Number);
  const pinnedParts = pinned.split(".").map(Number);
  const differing = floorParts.findIndex((part, index) => pinnedParts[index] !== part);
  return differing === -1 || pinnedParts[differing]! > floorParts[differing]!;
}

test("the peer dependency declares the CLI floor as a minimum, not an exact pin", () => {
  const peer = packageJson.peerDependencies?.[CLI];
  assert.ok(peer, `package.json peerDependencies must declare ${CLI}`);
  assert.match(
    peer,
    /^>=\d+\.\d+\.\d+$/,
    `peerDependencies["${CLI}"] must be a >= floor so any newer host CLI satisfies it, got ${peer}`,
  );
});

test("the extension manifest declares the same floor the CLI actually enforces", () => {
  const peer = packageJson.peerDependencies?.[CLI];
  assert.ok(peer);
  const declared = extensionManifest.pm_min_version;
  assert.strictEqual(
    typeof declared,
    "string",
    "manifest.json must declare a top-level pm_min_version — it is the only floor the pm CLI reads, so without it the CLI enforces no floor. npm still enforces the peerDependencies floor, but only for a locally resolved dependency, never for a globally installed host CLI",
  );
  assert.strictEqual(
    declared,
    peer.slice(">=".length),
    "manifest.json pm_min_version must equal the peerDependencies floor, or npm and the pm CLI enforce different minimums",
  );
});

test("the development dependency is an exact pin at or above the declared floor", () => {
  const dev = packageJson.devDependencies?.[CLI];
  assert.ok(dev, `package.json devDependencies must declare ${CLI}`);
  assert.match(
    dev,
    EXACT_VERSION,
    `devDependencies["${CLI}"] must be an exact pin so CI and a working copy resolve the same CLI, got ${dev}`,
  );
  const declared = extensionManifest.pm_min_version;
  assert.strictEqual(
    typeof declared,
    "string",
    `manifest.json pm_min_version must be a string to be comparable, got ${typeof declared}`,
  );
  assert.match(
    declared as string,
    EXACT_VERSION,
    `manifest.json pm_min_version must be an exact three-part version to be comparable, got ${String(declared)}`,
  );
  assert.ok(
    atOrAbove(dev, declared as string),
    `the pinned development CLI ${dev} is below the declared floor ${String(declared)}`,
  );
});

test("the version comparison orders YYYY.M.D numerically, not lexicographically", () => {
  // In the repository as it stands the pin equals the floor, so the
  // greater-than branch of atOrAbove is never reached by the assertion above.
  // A comparison whose ordering branch is never executed is not verified by
  // the suite passing — V8 does not even report a branch it never reaches —
  // so the ordering is exercised here directly.
  assert.ok(atOrAbove("2026.8.15", "2026.8.15"), "an equal pin satisfies the floor");
  assert.ok(atOrAbove("2026.8.15", "2026.8.7"), "a later day satisfies an earlier floor");
  assert.ok(!atOrAbove("2026.8.14", "2026.8.15"), "an earlier day must not satisfy a later floor");
  assert.ok(!atOrAbove("2026.8.7", "2026.8.15"), "the lexicographic trap: 2026.8.7 is BELOW 2026.8.15");
  assert.ok(atOrAbove("2026.9.1", "2026.8.31"), "a later month outranks any day of an earlier one");
  assert.ok(!atOrAbove("2026.7.31", "2026.8.1"), "an earlier month never satisfies a later one");
  assert.ok(atOrAbove("2027.1.1", "2026.12.31"), "a later year outranks any date of an earlier one");
  assert.ok(!atOrAbove("2025.12.31", "2026.1.1"), "an earlier year never satisfies a later one");
});
