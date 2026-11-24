import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inspectReleaseCaller } from "pm-ops/release-caller";
import { parse } from "yaml";

/** Named Actions steps as they execute after YAML block scalar decoding. */
interface ReleaseStep {
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  "continue-on-error"?: boolean;
}

/** Job-level conditions and permissions are part of the release contract. */
interface ReleaseJob {
  if: string;
  env: Record<string, string>;
  permissions: Record<string, string>;
  steps: ReleaseStep[];
}

/** Local caller fields owned by this package. */
interface ReleaseCaller {
  on: {
    schedule: { cron: string }[];
    workflow_dispatch: { inputs: Record<string, { type: string; default: boolean; description: string }> };
  };
  permissions: Record<string, string>;
  jobs: { release: { uses: string; permissions: Record<string, string>; with: Record<string, string> } };
}

/** Reusable workflow fields consumed by the local contract tests. */
interface CanonicalRelease {
  source: string;
  on: { workflow_call: { inputs: Record<string, { default: string | boolean }> } };
  jobs: Record<string, ReleaseJob>;
}

export const callerSource = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
export const caller = parse(callerSource) as ReleaseCaller;
let pinnedRelease: Promise<CanonicalRelease> | undefined;

/** Audit the pinned source without keeping another copy of the release workflow. */
export function canonicalRelease(): Promise<CanonicalRelease> {
  return pinnedRelease ??= (async () => {
    // The attestation audit verifies the tag against its canonical commit.
    // Check the structure before fetching public, credential-free raw source.
    const result = inspectReleaseCaller(callerSource, () => { throw new Error("Offline structural check"); });
    assert.notEqual(result.status, "refused", result.errors.join("\n"));
    const sha = caller.jobs.release.uses.split("@")[1];
    const url = `https://raw.githubusercontent.com/unbraind/pm-ops/${sha}/.github/workflows/daily-release.yml`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
    assert.ok(response.ok, `Cannot read pinned Daily Release source (HTTP ${response.status})`);
    const source = await response.text();
    return { ...(parse(source) as Omit<CanonicalRelease, "source">), source };
  })();
}

/** Require one named shell step within the job that owns its authority. */
export function releaseStep(job: ReleaseJob, name: string): ReleaseStep & { run: string } {
  const matches = job.steps.filter(step => step.name === name);
  assert.equal(matches.length, 1, name);
  const step = matches[0]!;
  assert.equal(typeof step.run, "string", name);
  return { ...step, run: step.run! };
}

/** Ignore whole-line comments in executable scripts. */
export function executable(source: string): string {
  return source.replace(/^[ \t]*#[^\r\n]*$/gm, "");
}
