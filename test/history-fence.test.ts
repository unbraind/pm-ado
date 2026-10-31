/** Real native histories and forward-only refusal without restoring saved state. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as sdk from "@unbrained/pm-cli/sdk";
import { NativeWriteFence, NativeHistoryConflict, nativeHead, isNativeHead } from "../history-fence.ts";
import { NativeWriteFence as BuiltNativeWriteFence } from "../dist/history-fence.js";

test("review lifecycle property accepts every native event in an owned transition and refuses every later peer event", async (t) => {
  for (const [name, Fence] of [["source", NativeWriteFence], ["built", BuiltNativeWriteFence]] as const) {
    for (const assignment of [undefined, "mapped-agent"]) await t.test(`${name}:${assignment ?? "unassigned"}`, async (sub) => {
      const f = await fixture(sub);
      if (assignment !== undefined) await f.pm.update(f.item.id, { assignee: assignment });
      const fence = new Fence(sdk, f.pmRoot, "history-agent");
      await fence.capture(f.item.id);
      for (const status of ["closed", "open", "canceled", "in_progress", "blocked", "closed"]) {
        const before = await sdk.readHistorySnapshot(sdk.getHistoryPath(f.pmRoot, f.item.id), f.item.id);
        await fence.update(f.item.id, { status, closeReason: "Reviewed lifecycle transition" }, `review-lifecycle-${status}`);
        await fence.assertCurrent(f.item.id);
        const item = (await f.pm.listAllComplete()).items.find((item) => item.id === f.item.id)!;
        assert.equal(item.status, status);
        if (status === "closed") assert.equal(item.assignee, undefined, "native close clears assignment");
        assert.deepEqual(fence.head(f.item.id), await nativeHead(sdk, f.pmRoot, f.item.id));
        const after = await sdk.readHistorySnapshot(sdk.getHistoryPath(f.pmRoot, f.item.id), f.item.id);
        assert.ok(after.raw!.startsWith(before.raw!), "every lifecycle event is retained");
        assert.ok(after.entries.slice(before.entries.length).every((entry) => entry.author === "history-agent" && entry.message?.includes(`review-lifecycle-${status}`)));
      }
      // Reapply the mapped field after native close; an explicit peer clear is a real edit.
      await fence.update(f.item.id, { assignee: "mapped-agent" }, "review-mapped-assignment");
      await f.pm.update(f.item.id, { unset: ["assignee"] });
      const peer = (await f.pm.listAllComplete()).items.find((item) => item.id === f.item.id)!;
      const before = (await sdk.readHistorySnapshot(sdk.getHistoryPath(f.pmRoot, f.item.id), f.item.id)).raw;
      await assert.rejects(fence.update(f.item.id, { assignee: "mapped-agent" }, "review-stale-assignment"), { kind: "sync_conflict" });
      assert.deepEqual((await f.pm.listAllComplete()).items.find((item) => item.id === f.item.id), peer);
      assert.equal((await sdk.readHistorySnapshot(sdk.getHistoryPath(f.pmRoot, f.item.id), f.item.id)).raw, before);
    });
  }
});

test("forward-only reviewer cycle fixture never restores a now-invalid parent", async (t) => {
  const f = await fixture(t);
  const a = (await f.pm.create({ type: "Task", title: "A" })).item;
  const b = (await f.pm.create({ type: "Task", title: "B" })).item;
  await f.pm.update(f.item.id, { parent: a.id });
  const fence = new NativeWriteFence(sdk, f.pmRoot, "history-agent", async (id, options) => {
    const result = await f.pm.update(id, options); // X moves from A to B.
    await f.pm.update(a.id, { parent: id }); // This is valid only while X remains under B.
    await f.pm.update(id, { title: "Peer title" });
    return result;
  });
  await fence.capture(f.item.id);
  await assert.rejects(fence.update(f.item.id, { parent: b.id }, "forward-cycle"), (error: unknown) => {
    assert.ok(error instanceof NativeHistoryConflict);
    assert.equal(error.kind, "sync_conflict");
    assert.equal(error.item, f.item.id);
    assert.equal(error.fields.title.current, "Peer title");
    return true;
  });
  assert.equal((await f.pm.get(f.item.id)).item.parent, b.id);
  assert.equal((await f.pm.get(f.item.id)).item.title, "Peer title");
  assert.equal((await f.pm.get(a.id)).item.parent, f.item.id);
  const rows = (await f.pm.listAllComplete()).items;
  for (const row of rows) {
    const seen = new Set<string>();
    let current: string | undefined = row.id;
    while (current !== undefined) { assert.ok(!seen.has(current), "no persisted hierarchy cycle"); seen.add(current); current = rows.find((item) => item.id === current)?.parent; }
  }
  const before = (await sdk.readHistorySnapshot(sdk.getHistoryPath(f.pmRoot, f.item.id), f.item.id)).raw;
  const retry = new NativeWriteFence(sdk, f.pmRoot, "history-agent");
  await retry.capture(f.item.id);
  assert.equal((await sdk.readHistorySnapshot(sdk.getHistoryPath(f.pmRoot, f.item.id), f.item.id)).raw, before, "replanning never replays compensation");
});

test("forward-only prewrite comparisons name fields and leave every peer value intact", async (t) => {
  for (const patch of [{ title: "Peer" }, { tags: '["peer"]' }, { body: "Peer body" }, { status: "blocked" }, { assignee: "peer-agent" }]) await t.test(JSON.stringify(patch), async (sub) => {
    const f = await fixture(sub);
    const before = (await f.pm.get(f.item.id, { depth: "full" })).item;
    await f.pm.update(f.item.id, patch);
    const peer = (await f.pm.get(f.item.id, { depth: "full" })).item;
    await assert.rejects(f.fence.update(f.item.id, patch, "forward-prewrite"), (error: unknown) => {
      assert.ok(error instanceof NativeHistoryConflict);
      const key = Object.keys(patch)[0]!;
      assert.equal(error.kind, "sync_conflict");
      assert.equal(error.item, f.item.id);
      assert.deepEqual(error.fields[key], { base: before[key] ?? null, current: peer[key] ?? null });
      return true;
    });
    assert.deepEqual((await f.pm.get(f.item.id, { depth: "full" })).item, peer);
  });
});


test("forward-only dispatch window is measured as an upper bound, never advertised as isolation", async (t) => {
  const f = await fixture(t), windows: number[] = [];
  const fence = new NativeWriteFence(sdk, f.pmRoot, "history-agent");
  await fence.capture(f.item.id);
  for (let i = 0; i < 12; i++) { await fence.update(f.item.id, { title: `Forward ${i}` }, `window-${i}`); windows.push(fence.lastWriteWindowMs); }
  assert.equal(windows.length, 12);
  assert.ok(windows.every((value) => value > 0));
  t.diagnostic(JSON.stringify({ samples: windows.length, final_read_to_completion_upper_bound_ms: { min: Math.min(...windows), max: Math.max(...windows) } }));
});

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

test("birth witnesses accept the exact native create receipt and reject absent or mismatched births", async (t) => {
  const f = await fixture(t);
  const fence = new NativeWriteFence(sdk, f.pmRoot, "history-agent");
  await fence.captureCreated(f.item);
  assert.equal(fence.head(f.item.id).length, 1);
  assert.deepEqual(fence.head(f.item.id), await nativeHead(sdk, f.pmRoot, f.item.id));
  const before = (await sdk.readHistorySnapshot(sdk.getHistoryPath(f.pmRoot, f.item.id), f.item.id)).raw;
  await assert.rejects(fence.captureCreated({ ...f.item, title: "Not the SDK receipt" }), NativeHistoryConflict);
  await assert.rejects(fence.captureCreated({ ...f.item, id: "history-absent" }), NativeHistoryConflict);
  assert.equal((await sdk.readHistorySnapshot(sdk.getHistoryPath(f.pmRoot, f.item.id), f.item.id)).raw, before);
});

test("birth witnesses preserve native create defaults, lifecycle states and creator receipts", async (t) => {
  const f = await fixture(t);
  const cases: sdk.PmCreateActionOptions[] = [
    { title: "Tag and body receipt", tags: '["z","a","z"]', description: "  Native description  ", body: "Native body\r\n" },
    { title: "Different creator receipt", author: "creator-agent", priority: 0, status: "blocked" },
    { title: "Parent receipt", parent: f.item.id },
    { title: "Terminal receipt", status: "closed", closeReason: "Created complete" },
    { title: "Context receipt", comment: ["text=Created context"], note: ["text=Native note"] },
  ];
  for (const options of cases) {
    const { item } = await f.pm.create({ type: "Task", ...options });
    const fence = new NativeWriteFence(sdk, f.pmRoot, "history-agent");
    await fence.captureCreated(item);
    await fence.update(item.id, { description: "Owned follow-up" }, "birth-receipt-control");
    assert.equal((await f.pm.get(item.id)).item.description, "Owned follow-up");
  }
});

test("birth witness property refuses every nonempty fixed-clock peer edit set including ABA and audits", async (t) => {
  let seed = 0x6b17cafe;
  for (let sequence = 0; sequence < 32; sequence++) await t.test(String(sequence), async (sub) => {
    const f = await fixture(sub);
    sub.mock.timers.enable({ apis: ["Date"], now: new Date(f.item.updated_at) });
    try {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const fields = (seed % 31) + 1;
      await f.pm.update(f.item.id, { ...(fields & 1 ? { title: "Peer title" } : {}), ...(fields & 2 ? { tags: '["peer"]' } : {}),
        ...(fields & 4 ? { body: "Peer body" } : {}), ...(fields & 8 ? { status: "blocked" } : {}), ...(fields & 16 ? { priority: 0 } : {}) });
      if (sequence % 3 === 0) await f.pm.update(f.item.id, { title: f.item.title, tags: JSON.stringify(f.item.tags), body: "", status: f.item.status, priority: f.item.priority });
      if (sequence % 3 === 1) await sdk.mutateItemWithHistoryContext({ pmRoot: f.pmRoot, settings: await sdk.readSettings(f.pmRoot),
        id: f.item.id, author: "history-agent", op: "update", historyContext: { peer_birth_audit: true }, mutate: () => ({ changedFields: [] }) });
      const before = (await f.pm.get(f.item.id, { depth: "full" })).item;
      const history = (await sdk.readHistorySnapshot(sdk.getHistoryPath(f.pmRoot, f.item.id), f.item.id)).raw;
      const fence = new NativeWriteFence(sdk, f.pmRoot, "history-agent");
      await assert.rejects(fence.captureCreated(f.item), NativeHistoryConflict);
      await assert.rejects(fence.update(f.item.id, { title: "Must not overwrite a peer" }, "birth-property"), NativeHistoryConflict);
      assert.deepEqual((await f.pm.get(f.item.id, { depth: "full" })).item, before);
      assert.equal((await sdk.readHistorySnapshot(sdk.getHistoryPath(f.pmRoot, f.item.id), f.item.id)).raw, history);
    } finally { sub.mock.timers.reset(); }
  });
  t.diagnostic("seed 0x6b17cafe: 32 post-birth peer edit sets, including ABA and immutable audit witnesses");
});

test("native SDK refusals preserve their cause unless a peer advanced history", async (t) => {
  for (const peer of [false, true]) await t.test(String(peer), async (sub) => {
    const f = await fixture(sub);
    const fence = new NativeWriteFence(sdk, f.pmRoot, "history-agent", async (id, options) => {
      if (peer) await f.pm.update(id, { title: "Peer before SDK refusal" });
      return f.pm.update(id, options);
    });
    await fence.capture(f.item.id);
    const attempted = fence.update(f.item.id, { priority: 99 }, "native-invalid-priority");
    if (peer) await assert.rejects(attempted, NativeHistoryConflict);
    else await assert.rejects(attempted, /priority/iu);
    assert.equal((await f.pm.get(f.item.id)).item.title, peer ? "Peer before SDK refusal" : "Initial");
  });
});

test("forward-only normal updates preserve their native witness across fresh plans", async (t) => {
  const f = await fixture(t);
  await f.fence.update(f.item.id, { title: "After" }, "native-normal");
  assert.equal((await f.pm.get(f.item.id)).item.title, "After");
  await f.fence.assertCurrent(f.item.id);
  const head = f.fence.head(f.item.id);
  // A fresh plan reads completed native events without replaying abandoned work.
  const recovered = new NativeWriteFence(sdk, f.pmRoot, "history-agent");
  await recovered.capture(f.item.id);
  assert.deepEqual(recovered.head(f.item.id), head);
  assert.deepEqual(await nativeHead(sdk, f.pmRoot, f.item.id), head);
});

test("native history fence refuses unfenced targets and catches read-only ABA", async (t) => {
  const f = await fixture(t);
  await assert.rejects(new NativeWriteFence(sdk, f.pmRoot, "history-agent").update(f.item.id, { title: "Unsafe" }, "uninspected"), NativeHistoryConflict);
  await f.pm.update(f.item.id, { title: "Peer" });
  await f.pm.update(f.item.id, { title: "Initial" });
  await assert.rejects(f.fence.assertCurrent(f.item.id), NativeHistoryConflict);
  assert.deepEqual(await nativeHead(sdk, f.pmRoot, "history-absent"), { length: 0, hash: "empty" });
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
  await fence.captureCreated(document.metadata);
  await fence.capture(id);
  assert.equal(fence.head(id).hash, sdk.hashHistoryRecord(legacy));
  await fence.update(id, { title: "Initial" }, "native-legacy-noop");
  await fence.update(id, { title: "Legacy works" }, "native-legacy");
  assert.equal((await f.pm.get(id)).item.title, "Legacy works");
  assert.ok((await sdk.readHistorySnapshot(sdk.getHistoryPath(f.pmRoot, id), id)).raw!.startsWith(raw));
});

test("forward-only absent targets refuse, equivalent values add no synthetic history, and missing fields stay absent", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(new NativeHistoryConflict().fields, {});
  await assert.rejects(f.fence.capture("history-missing"), { kind: "sync_conflict", item: "history-missing" });
  await assert.rejects(new NativeWriteFence(sdk, f.pmRoot, "history-agent").assertCurrent(f.item.id), { kind: "sync_conflict", item: f.item.id });
  const head = f.fence.head(f.item.id);
  await f.fence.update(f.item.id, { title: "Initial" }, "forward-equivalent");
  assert.deepEqual(f.fence.head(f.item.id), head);
  await f.fence.update(f.item.id, { description: "" }, "forward-empty-description");
  await f.fence.update(f.item.id, { unset: ["assignee"] }, "forward-empty-assignment");
  const settings = await sdk.readSettings(f.pmRoot), id = "history-without-stream";
  writeFileSync(sdk.getItemPath(f.pmRoot, "Task", id, settings.item_format), sdk.serializeItemDocument({ metadata: { ...f.item, id }, body: "" }, { schema: settings.schema }));
  const legacy = new NativeWriteFence(sdk, f.pmRoot, "history-agent");
  await legacy.capture(id);
  await legacy.update(id, { title: "Initial" }, "forward-legacy-noop");
  assert.deepEqual(legacy.head(id), { length: 0, hash: "empty" });
});

test("forward-only writes retain SDK field validation, relation parsing and explicit peer clears", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.fence.update(f.item.id, { field: ["constructor=unsafe"] }, "unknown-field"), sdk.PmCliError);
  const other = (await f.pm.create({ type: "Task", title: "Related" })).item;
  await f.fence.update(f.item.id, { dep: [`id=${other.id},kind=related`], message: "Forward relation" }, "forward-relation");
  assert.equal((await f.pm.get(f.item.id)).item.dependencies![0]!.id, other.id);
  await f.fence.update(f.item.id, { assignee: "before-agent" }, "before-clear");
  await f.pm.update(f.item.id, { unset: ["assignee"] });
  await assert.rejects(f.fence.update(f.item.id, { assignee: "stale-agent" }, "after-clear"), (error: unknown) => {
    assert.ok(error instanceof NativeHistoryConflict);
    assert.deepEqual(error.fields.assignee, { base: "before-agent", current: null });
    return true;
  });
  assert.equal((await f.pm.get(f.item.id)).item.assignee, undefined);
});
