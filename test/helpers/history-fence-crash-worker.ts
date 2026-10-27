/** Native dispatch/verification process boundaries with real SDK writers. */
import * as sdk from "@unbrained/pm-cli/sdk";
import { dirname } from "node:path";
import { NativeWriteFence } from "../../dist/history-fence.js";

const [pmRoot, id, phase] = process.argv.slice(2);
const cwd = dirname(dirname(pmRoot));
const pm = new sdk.PmClient({ cwd, pmRoot, author: "history-agent", noExtensions: true });
/** Wait for the parent to edit or kill this process at an exact native boundary. */
async function boundary(at: string): Promise<void> {
  await new Promise<void>((done) => {
    process.once("message", () => done());
    process.send!({ phase: at });
  });
}
const fence = new NativeWriteFence(sdk, pmRoot, "history-agent", async (item, options) => {
  await boundary("before-native");
  const result = await pm.update(item, options);
  if (phase === "dispatched") await boundary("dispatched");
  return result;
}, async (event) => {
  if (phase === "verified" && event.transition === "step_applied") await boundary("verified");
});
await fence.capture(id);
await fence.update(id, { title: "Stale child write", assignee: "stale-agent" }, "native-sigkill");
process.disconnect!();
