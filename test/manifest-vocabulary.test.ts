import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { checkExtensionManifestCompatibility } from "@unbrained/pm-cli/sdk";

const repoRoot = resolve(import.meta.dirname, "..");

const packageJson = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
) as { devDependencies?: Record<string, string> };
const extensionManifest = JSON.parse(
  readFileSync(resolve(repoRoot, "manifest.json"), "utf8"),
) as Record<string, unknown>;

/**
 * The pm-cli extension-manifest vocabulary is a CLOSED set of eighteen keys
 * (name, version, entry, priority, description, author, capabilities,
 * manifest_version, pm_min_version, pm_max_version, engines, trusted,
 * provenance, sandbox_profile, permissions, activation, contributions,
 * legacy_capability_aliases). Since pm-cli 2026.8.19 any other key yields a
 * `manifest_unknown_key` warning at load time. This repository's manifest used
 * to carry an inert top-level `"pm": {"compatibility": "v2"}` key that nothing
 * in the repo reads; downstream strict assertions (e.g. unbraind/pm-linear PRs
 * #75/#76, which expect finding codes exactly `["pm_min_version_unmet"]`)
 * instead saw `["manifest_unknown_key", "pm_min_version_unmet"]` and failed.
 * This test pins the manifest to the closed vocabulary so an unknown key can
 * never be re-introduced silently: it checks the pinned CLI version is exact
 * (so the closed-vocabulary check cannot be run against a CLI too old to know
 * the vocabulary), then asserts zero unknown-key findings.
 */
test("the extension manifest uses only keys the pm CLI recognizes", () => {
  const pin = packageJson.devDependencies?.["@unbrained/pm-cli"] ?? "";
  assert.match(pin, /^\d+\.\d+\.\d+$/, "the pinned CLI version must be an exact three-part version");
  const result = checkExtensionManifestCompatibility(extensionManifest, { pmVersion: pin });
  const unknownKeyFindings = result.findings.filter((finding) => finding.code === "manifest_unknown_key");
  assert.deepStrictEqual(
    unknownKeyFindings,
    [],
    `manifest.json carries keys outside the closed manifest vocabulary: ${unknownKeyFindings.map((f) => f.path).join(", ")}`,
  );
});
