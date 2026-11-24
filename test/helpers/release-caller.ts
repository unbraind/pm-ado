import { readFileSync } from "node:fs";
import { inspectReleaseCaller } from "pm-ops/release-caller";
import { parse } from "yaml";

/** Local caller fields owned by this package. */
interface ReleaseCaller {
  on: {
    schedule: { cron: string }[];
    workflow_dispatch: { inputs: Record<string, { type: string; default: boolean; description: string }> };
  };
  permissions: Record<string, string>;
  jobs: { release: { uses: string; permissions: Record<string, string>; with: Record<string, string> } };
}

export const callerSource = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
export const caller = parse(callerSource) as ReleaseCaller;

/** Check the caller shape without depending on a live GitHub tag lookup. */
export function releaseCallerPolicy(): ReturnType<typeof inspectReleaseCaller> {
  return inspectReleaseCaller(callerSource, () => { throw new Error("Only local caller structure is under test"); });
}
