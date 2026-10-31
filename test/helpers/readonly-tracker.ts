/** Native read-only tracker probe setup shared by public-corpus acceptance scripts. */
import { join } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { authoritativeDigest } from "./authoritative-digest.ts";

/** Capture authoritative bytes before constructing the native reader or populating derived caches. */
export function readOnlyTracker(root: string) {
  const pmRoot = join(root, ".agents/pm");
  const before = authoritativeDigest(pmRoot);
  return { pmRoot, before, pm: new PmClient({ cwd: root, pmRoot, author: "fixture-agent" }) };
}
