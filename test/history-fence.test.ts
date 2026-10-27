/** Real native histories, fixed clocks and crash-resumable selective compensation. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fork } from "node:child_process";
import * as sdk from "@unbrained/pm-cli/sdk";
import { NativeWriteFence, NativeHistoryConflict, nativeHead, isNativeHead } from "../history-fence.ts";

/** Build a real tracker outside git without SDK substitutes. */
async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "ado-native-history-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pmRoot = join(root, ".agents/pm");
  const pm = new sdk.PmClient({ cwd: root, pmRoot, author: "history-agent", noExtensions: true });
  await pm.run("init", { prefix: "history" });
  const { item } = await pm.create({ type: "Task", title: "Initial" });
  const fence = new NativeWriteFence(sdk, pmRoot, "history-agent");
  await fence.capture(item.id);
  return { pm, pmRoot, item, fence };
}

test("native history witnesses accept empty and hashed heads and reject malformed coordinates", () => {
  for (const value of [undefined, null, [], "head", {}, { length: -1, hash: "empty" }, { length: 1.5, hash: "empty" },
    { length: 0, hash: "bad" }, { length: 1, hash: null }, { length: 1, hash: "bad" }]) assert.equal(isNativeHead(value), false);
  assert.equal(isNativeHead({ length: 0, hash: "empty" }), true);
  assert.equal(isNativeHead({ length: 1, hash: "a".repeat(64) }), true);
});

test("native history fence normal update and committed replay retain their exact immutable witness", async (t) => {
  const f = await fixture(t);
  await f.fence.update(f.item.id, { title: "After" }, "native-normal");
  assert.equal((await f.pm.get(f.item.id)).item.title, "After");
  await f.fence.assertCurrent(f.item.id);
  const head = f.fence.head(f.item.id);
  // Retry uses a new session and recovers the immutable marker rather than applying twice.
  const recovered = new NativeWriteFence(sdk, f.pmRoot, "history-agent");
  await recovered.capture(f.item.id);
  assert.deepEqual(recovered.head(f.item.id), head);
  assert.deepEqual(await nativeHead(sdk, f.pmRoot, f.item.id), head);
});

test("native history fence fixed-clock ordinary and ABA writes conflict and restore peer state", async (t) => {
  for (const aba of [false, true]) await t.test(String(aba), async (sub) => {
    const f = await fixture(sub);
    sub.mock.timers.enable({ apis: ["Date"], now: new Date(f.item.updated_at) });
    try {
      let peer: unknown;
      const fence = new NativeWriteFence(sdk, f.pmRoot, "history-agent", async (id, options) => {
        // Race after the fast precheck, immediately before the real native write.
        await f.pm.update(id, { title: "Foreign" });
        if (aba) await f.pm.update(id, { title: "Initial" });
        peer = (await f.pm.get(id)).item;
        return f.pm.update(id, options);
      });
      await fence.capture(f.item.id);
      await assert.rejects(fence.update(f.item.id, { title: "Stale", description: "Stale description", assignee: "stale-agent" }, "native-race"), NativeHistoryConflict);
      assert.ok(peer);
      assert.deepEqual((await f.pm.get(f.item.id)).item, peer);
      const entries = (await sdk.readHistorySnapshot(sdk.getHistoryPath(f.pmRoot, f.item.id), f.item.id)).entries;
      assert.ok(entries.some((entry) => entry.context?.ado_native_conflict === true));
      assert.equal(sdk.verifyHistoryChain(entries).ok, true);
    } finally { sub.mock.timers.reset(); }
  });
});

test("native history fence recovers crashes on either side of native dispatch and preserves later peer fields", async (t) => {
  for (const phase of ["before", "after", "after-peer"]) await t.test(phase, async (sub) => {
    const f = await fixture(sub);
    const head = f.fence.head(f.item.id);
    if (phase !== "before") {
      await f.pm.update(f.item.id, { title: "Peer before write", description: "Peer description" });
      await f.pm.update(f.item.id, { title: "Stale", description: "Stale description", body: "Stale body", tags: "stale", author: "history-agent",
        message: `bulk-item-transaction native-crashed native-fence:${head.length}:${head.hash} apply` });
      if (phase === "after-peer") await f.pm.update(f.item.id, { title: "Peer after write", body: "Peer body", author: "another-agent" });
    }
    const resumed = new NativeWriteFence(sdk, f.pmRoot, "history-agent");
    if (phase === "before") await resumed.capture(f.item.id);
    else await assert.rejects(resumed.capture(f.item.id), NativeHistoryConflict);
    const actual = (await f.pm.get(f.item.id)).item;
    assert.equal(actual.title, phase === "before" ? "Initial" : phase === "after-peer" ? "Peer after write" : "Peer before write");
    if (phase !== "before") {
      assert.equal(actual.description, "Peer description");
      assert.deepEqual(actual.tags, []);
      assert.equal((await f.pm.get(f.item.id, { depth: "full" })).item.body, phase === "after-peer" ? "Peer body" : "");
    }
    await resumed.capture(f.item.id);
    await resumed.update(f.item.id, { title: "Converged" }, "native-resumed");
    assert.equal((await f.pm.get(f.item.id)).item.title, "Converged");
  });
});

test("native history fence refuses unfenced targets and catches read-only ABA", async (t) => {
  const f = await fixture(t);
  await assert.rejects(new NativeWriteFence(sdk, f.pmRoot, "history-agent").update(f.item.id, { title: "Unsafe" }, "uninspected"), NativeHistoryConflict);
  await f.pm.update(f.item.id, { title: "Peer" });
  await f.pm.update(f.item.id, { title: "Initial" });
  await assert.rejects(f.fence.assertCurrent(f.item.id), NativeHistoryConflict);
  assert.deepEqual(await nativeHead(sdk, f.pmRoot, "history-absent"), { length: 0, hash: "empty" });
});

test("native history fence resumes every SDK journal transition without repeating native effects", async (t) => {
  for (const transition of ["prepared", "step_applied", "step_recorded", "committing", "committed"] as const) await t.test(transition, async (sub) => {
    const f = await fixture(sub);
    let stopped = false;
    const interrupted = new NativeWriteFence(sdk, f.pmRoot, "history-agent", undefined, (event) => {
      if (!stopped && event.transition === transition) { stopped = true; throw new sdk.WorkspaceTransactionInterruptedError(); }
    });
    await interrupted.capture(f.item.id);
    await assert.rejects(interrupted.update(f.item.id, { title: "Durable" }, "native-interruption"), sdk.WorkspaceTransactionInterruptedError);
    const resumed = new NativeWriteFence(sdk, f.pmRoot, "history-agent");
    await resumed.capture(f.item.id);
    if (transition === "prepared") await resumed.update(f.item.id, { title: "Durable" }, "native-interruption");
    const history = (await sdk.readHistorySnapshot(sdk.getHistoryPath(f.pmRoot, f.item.id), f.item.id)).entries;
    assert.equal(history.filter((entry) => entry.message?.startsWith("bulk-item-transaction native-interruption ")).length, 1);
    assert.equal((await f.pm.get(f.item.id)).item.title, "Durable");
    assert.ok((await sdk.runWorkspaceTransactionGc(f.pmRoot, { dryRun: true, retentionDays: Infinity })).entries.every((entry) => entry.status === "committed"));
  });
});

test("native history fence journal failure compensates once and refuses a committed journal without native proof", async (t) => {
  const f = await fixture(t);
  let failed = false;
  const broken = new NativeWriteFence(sdk, f.pmRoot, "history-agent", undefined, (event) => {
    if (!failed && event.transition === "committing") { failed = true; throw new Error("Synthetic journal failure"); }
  });
  await broken.capture(f.item.id);
  await assert.rejects(broken.update(f.item.id, { title: "Failed change" }, "native-journal-failure"), /Synthetic journal failure/u);
  assert.equal((await f.pm.get(f.item.id)).item.title, "Initial");
  const recovered = new NativeWriteFence(sdk, f.pmRoot, "history-agent");
  await assert.rejects(recovered.capture(f.item.id), NativeHistoryConflict);
  await recovered.capture(f.item.id);
  await recovered.update(f.item.id, { title: "Recovered" }, "native-journal-failure");
  assert.equal((await f.pm.get(f.item.id)).item.title, "Recovered");
  const head = recovered.head(f.item.id);
  const transactionId = `native-missing-proof-${sdk.deriveMutationTransactionId(JSON.stringify(head))}`;
  await sdk.commitWorkspaceTransaction({ pmRoot: f.pmRoot, author: "history-agent", transactionId,
    steps: [{ id: "native-write", inspect: async () => ({ state: "pending" }), apply: async () => undefined, compensate: async () => {} }] });
  await assert.rejects(recovered.update(f.item.id, { title: "Unproved" }, "native-missing-proof"), NativeHistoryConflict);
  assert.equal((await f.pm.get(f.item.id)).item.title, "Recovered");
});

test("native history fence accepts a legacy item-state-only birth record without rewriting its stream", async (t) => {
  const f = await fixture(t), id = "history-legacy";
  const settings = await sdk.readSettings(f.pmRoot);
  const document = { metadata: { ...f.item, id }, body: "" };
  const entry = sdk.createHistoryEntry({ author: "history-agent", nowIso: f.item.updated_at, op: "create", before: sdk.emptyImportedDocument(), after: document });
  // Construct a new legacy fixture at birth; existing fixture histories remain untouched.
  const { record_hash: _hash, record_hash_version: _version, ...legacy } = entry;
  const raw = JSON.stringify(legacy) + "\n";
  writeFileSync(sdk.getItemPath(f.pmRoot, "Task", id, settings.item_format), sdk.serializeItemDocument(document, { schema: settings.schema }));
  writeFileSync(sdk.getHistoryPath(f.pmRoot, id), raw);
  const fence = new NativeWriteFence(sdk, f.pmRoot, "history-agent");
  await fence.capture(id);
  assert.equal(fence.head(id).hash, sdk.hashHistoryRecord(legacy));
  await fence.update(id, { title: "Legacy works" }, "native-legacy");
  assert.equal((await f.pm.get(id)).item.title, "Legacy works");
  assert.ok((await sdk.readHistorySnapshot(sdk.getHistoryPath(f.pmRoot, id), id)).raw!.startsWith(raw));
});

test("native history fence SIGKILL after dispatch and verification recovers ordinary and ABA peers", { timeout: 90000 }, async (t) => {
  for (const phase of ["dispatched", "verified"]) for (const aba of [false, true]) await t.test(`${phase}:${aba}`, async (sub) => {
    const f = await fixture(sub);
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir(), NPM_CONFIG_USERCONFIG: "/dev/null" };
    for (const key of Object.keys(env)) if (/(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|CREDENTIAL|NPM_MEDIA_SERVER)/iu.test(key)) delete env[key as keyof typeof env];
    const child = fork(join(import.meta.dirname, "helpers/history-fence-crash-worker.ts"), [f.pmRoot, f.item.id, phase],
      { cwd: f.pmRoot, env, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "", edited = false;
    child.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });
    sub.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    child.on("message", (event: { phase: string }) => {
      if (event.phase === phase) child.kill("SIGKILL");
      else void (async () => {
        await f.pm.update(f.item.id, { title: "Foreign title", body: "Foreign context" });
        if (aba) await f.pm.update(f.item.id, { title: "Initial" });
        edited = true;
        child.send("continue");
      })();
    });
    const signal = await new Promise<NodeJS.Signals | null>((done, reject) => { child.once("error", reject); child.once("exit", (_code, stopped) => done(stopped)); });
    assert.equal(signal, "SIGKILL", stderr);
    assert.equal(edited, true);
    const resumed = new NativeWriteFence(sdk, f.pmRoot, "history-agent");
    await assert.rejects(resumed.capture(f.item.id), NativeHistoryConflict);
    const peer = (await f.pm.get(f.item.id, { depth: "full" })).item;
    assert.equal(peer.title, aba ? "Initial" : "Foreign title");
    assert.equal(peer.body, "Foreign context");
    assert.equal(peer.assignee, undefined);
    await resumed.capture(f.item.id);
    await resumed.update(f.item.id, { title: "Converged after crash" }, "native-after-sigkill");
    assert.equal((await f.pm.get(f.item.id)).item.title, "Converged after crash");
  });
});

test("native history fence preserves peer collection additions on both sides of a stale write", async (t) => {
  for (const prior of [false, true]) for (const clear of [false, true]) for (const clearAfter of [false, true]) await t.test(`${prior}:${clear}:${clearAfter}`, async (sub) => {
    const f = await fixture(sub);
    const targets: string[] = [];
    for (const title of ["Peer A", "Owned", "Peer B"]) targets.push((await f.pm.create({ type: "Task", title })).item.id);
    await f.pm.update(f.item.id, { tags: JSON.stringify(["shared"]) });
    const fence = new NativeWriteFence(sdk, f.pmRoot, "history-agent", async (id, options) => {
      await f.pm.update(id, { tags: JSON.stringify(prior ? ["peer-a", "shared"] : ["shared"]),
        ...(prior ? { dep: [`id=${targets[0]},kind=related`] } : { title: "Peer scalar" }) });
      const result = await f.pm.update(id, options);
      await f.pm.update(id, { tags: JSON.stringify(clearAfter ? [] : ["owned", "peer-a"]),
        ...(clearAfter ? { clearDeps: true } : { dep: [`id=${targets[2]},kind=related`] }) });
      return result;
    });
    await fence.capture(f.item.id);
    await assert.rejects(fence.update(f.item.id, { tags: JSON.stringify(["shared", "owned"]),
      ...(clear ? { clearDeps: true } : { replaceDeps: true, dep: [`id=${targets[1]},kind=related`] }) }, "native-collection-race"), NativeHistoryConflict);
    const actual = (await f.pm.get(f.item.id, { depth: "full" })).item;
    assert.deepEqual(actual.tags, !clearAfter || prior ? ["peer-a"] : []);
    assert.deepEqual((actual.dependencies ?? []).map((edge) => edge.id).sort(),
      [...(prior ? [targets[0]] : []), ...(clearAfter ? [] : [targets[2]])].sort());
  });
});
