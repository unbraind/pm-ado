/** Stop on either side of the real SDK write, including before the guard's post-read. */
import * as sdk from "@unbrained/pm-cli/sdk";
import { dirname } from "node:path";
import { NativeWriteFence } from "../../dist/history-fence.js";

const [pmRoot, id, plan, phase] = process.argv.slice(2);
const pm = new sdk.PmClient({ cwd: dirname(dirname(pmRoot)), pmRoot, author: "fixture-agent" });
/** Hand the parent an exact native boundary before it sends SIGKILL. */
async function stop(at: string): Promise<void> {
  if (phase !== at) return;
  await new Promise<void>((resolve) => { process.once("message", () => resolve()); process.send!({ phase: at }); });
}
const fence = new NativeWriteFence(sdk, pmRoot, "fixture-agent", async (item, options) => {
  await stop("before");
  const result = await pm.update(item, options);
  await stop("dispatched");
  return result;
});
await fence.capture(id);
await fence.update(id, { description: "Forward native value" }, `ado-sync-${plan}-native-crash`);
await stop("after");
process.disconnect!();
