/** Real process boundary worker; no SDK or transport substitutes. */
import { PmClient, createExtensionCommandSdk, runWithActiveExtensions } from "@unbrained/pm-cli/sdk";
import { dirname } from "node:path";
import { runSyncCommand } from "../../dist/sync.js";
import type { SyncBoundary } from "../../sync-outbox.ts";

const [pmRoot, mode] = process.argv.slice(2);
if (mode !== "import" && mode !== "export" && mode !== "sync") throw new Error("invalid worker mode");
const cwd = dirname(dirname(pmRoot));
process.chdir(cwd);
const pm = new PmClient({ cwd, pmRoot, author: "fixture-agent" });
let index = 0;
/** Let the parent edit the real tracker or kill this process at an exact boundary. */
async function boundary(event: SyncBoundary): Promise<void> {
  const position = index++;
  await new Promise<void>((done) => {
    process.once("message", () => done());
    process.send!({ kind: "boundary", index: position, event });
  });
}
const result = await runWithActiveExtensions({ cwd, path: pmRoot }, () => runSyncCommand({
  command: `ado ${mode}`, args: [], options: {}, global: {}, pm_root: pmRoot,
  sdk: createExtensionCommandSdk(pmRoot, pm),
}, mode, boundary));
process.send!({ kind: "done", result });
process.disconnect!();
