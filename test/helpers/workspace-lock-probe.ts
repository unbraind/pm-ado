/** Standalone SDK capability diagnostic; exit four means the required isolation is unavailable. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@unbrained/pm-cli/sdk";

/** Run a genuinely separate native SDK writer while the coordinator holds its workspace lease. */
async function peerWrite(pmRoot: string, id: string, patch: sdk.PmUpdateActionOptions): Promise<void> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir(), NPM_CONFIG_USERCONFIG: "/dev/null" };
  for (const key of Object.keys(childEnv)) if (/(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|CREDENTIAL|NPM_MEDIA_SERVER)/iu.test(key)) delete childEnv[key];
  const child = spawn(process.execPath, [import.meta.filename, "peer", pmRoot, id, JSON.stringify(patch)],
    { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let committed = false;
  child.stdout.on("data", (chunk: Buffer) => { committed ||= chunk.toString().includes("peer-committed"); });
  // A bounded wait prevents a fixed SDK from hanging this capability diagnostic.
  child.stderr.resume();
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  clearTimeout(timer);
  if (code !== 0 || !committed) throw new Error("Peer did not commit while the workspace lock was held; inspect SDK isolation before changing sync.");
}

if (process.argv[2] === "peer") {
  const [pmRoot, id, patch] = process.argv.slice(3);
  await sdk.update(id, { ...JSON.parse(patch) as sdk.PmUpdateActionOptions, author: "peer-agent" }, { pmRoot });
  process.stdout.write("peer-committed\n");
} else {
  const root = await mkdtemp(join(tmpdir(), "ado-workspace-lock-"));
  const pmRoot = join(root, ".agents", "pm");
  const pm = new sdk.PmClient({ cwd: root, pmRoot, author: "probe-agent", noExtensions: true });
  try {
    await pm.run("init", { prefix: "lock" });
    const { item: parentA } = await pm.create({ type: "Task", title: "Parent A" });
    const { item: parentB } = await pm.create({ type: "Task", title: "Parent B" });
    const cases: { field: string; peer: sdk.PmUpdateActionOptions; own: sdk.PmUpdateActionOptions;
      project(item: sdk.GetResult["item"]): unknown; expected: unknown }[] = [
      { field: "title", peer: { title: "Peer" }, own: { title: "Azure" }, project: (item) => item.title, expected: "Peer" },
      { field: "parent", peer: { parent: parentB.id }, own: { parent: parentA.id }, project: (item) => item.parent ?? "", expected: parentB.id },
      { field: "relation", peer: { dep: [`id=${parentB.id},kind=related`] }, own: { clearDeps: true }, project: (item) => item.dependencies?.map((dep) => dep.id) ?? [], expected: [parentB.id] },
      { field: "assignee", peer: { assignee: "peer-agent" }, own: { assignee: "azure-agent", force: true }, project: (item) => item.assignee ?? "", expected: "peer-agent" },
    ];
    let violations = 0;
    for (const scenario of cases) {
      const { item } = await pm.create({ type: "Task", title: "Base" });
      const result = await sdk.commitWorkspaceTransaction({ pmRoot, author: "probe-agent", transactionId: `${item.id}-${randomUUID()}`,
        steps: [{ id: "read-decide-write",
          inspect: async () => {
            // A real current read and decision under the advertised workspace lock.
            if (!sdk.stableValueEquals(scenario.project((await pm.get(item.id)).item), scenario.project(item))) throw new Error("Current field differs from the saved fixture base");
            return { state: "pending" };
          },
          apply: async () => {
            await peerWrite(pmRoot, item.id, scenario.peer);
            await pm.update(item.id, scenario.own);
            return { applied: true };
          },
          // This diagnostic performs no rollback or private filesystem mutation.
          compensate: async () => {},
        }] });
      const preserved = sdk.stableValueEquals(scenario.project((await pm.get(item.id)).item), scenario.expected);
      if (!preserved) violations++;
      process.stdout.write(JSON.stringify({ field: scenario.field, peer_committed_under_workspace_lock: true,
        transaction: result.status, peer_preserved: preserved }) + "\n");
    }
    process.stdout.write(JSON.stringify({ cases: cases.length, isolation_violations: violations }) + "\n");
    process.exitCode = violations === 0 ? 0 : 4;
  } finally { await rm(root, { recursive: true, force: true }); }
}
