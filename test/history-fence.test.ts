/** Real native histories and forward-only refusal without restoring saved state. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as sdk from "@unbrained/pm-cli/sdk";
import { NativeWriteFence, NativeHistoryConflict, nativeHead, isNativeHead } from "../history-fence.ts";
import { NativeWriteFence as BuiltNativeWriteFence } from "../dist/history-fence.js";

/** Commit through an independent OS process so the peer cannot inherit a revision scope. */
async function peerWrite(pmRoot: string, id: string, options: sdk.PmUpdateActionOptions, mode = "update"): Promise<void> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, NPM_CONFIG_USERCONFIG: "/dev/null" };
  // Keep the inherited coverage preload's inputs; drop tracker settings and credentials.
  for (const key of Object.keys(childEnv)) if (/(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|CREDENTIAL|NPM_MEDIA_SERVER|^PM_(?!ADO_STATEMENT_(?:SOURCES|REPORT_DIR)$))/iu.test(key)) delete childEnv[key];
  await promisify(execFile)(process.execPath, [join(import.meta.dirname, "helpers/native-revision-peer.ts"), pmRoot, id, JSON.stringify(options), mode],
    { env: childEnv, timeout: 30000 });
}

test("decision-bound revision guards refuse process writes in the final dispatch interval", async (t) => {
  for (const [name, Fence] of [["source", NativeWriteFence], ["built", BuiltNativeWriteFence]] as const) {
    for (const field of ["title", "body", "assignee", "status", "parent", "dependencies"]) await t.test(`${name}:${field}`, async (sub) => {
      const f = await fixture(sub);
      const other = (await f.pm.create({ type: "Task", title: "Other endpoint" })).item;
      const patches: Record<string, { peer: sdk.PmUpdateActionOptions; own: sdk.PmUpdateActionOptions }> = {
        title: { peer: { title: "Peer title" }, own: { title: "Azure title" } },
        body: { peer: { body: "Peer body" }, own: { description: "Azure description" } },
        assignee: { peer: { assignee: "peer-agent" }, own: { assignee: "azure-agent", force: true } },
        status: { peer: { status: "blocked" }, own: { status: "closed", closeReason: "Azure close" } },
        parent: { peer: { parent: other.id }, own: { unset: ["parent"] } },
        dependencies: { peer: { dep: [`id=${other.id},kind=related`] }, own: { clearDeps: true } },
      };
      const patch = patches[field]!;
      let peer: sdk.ItemDocument | undefined, history: string | null | undefined;
      const fence = new Fence(sdk, f.pmRoot, "history-agent", async (id, options) => {
        await peerWrite(f.pmRoot, id, patch.peer);
        const settings = await sdk.readSettings(f.pmRoot);
        const located = await sdk.locateItem(f.pmRoot, id, settings.id_prefix, settings.item_format);
        peer = (await sdk.readLocatedItem(located!, { schema: settings.schema })).document;
        history = (await sdk.readHistorySnapshot(sdk.getHistoryPath(f.pmRoot, id), id)).raw;
        return f.pm.update(id, options);
      });
      await fence.capture(f.item.id);
      await assert.rejects(fence.update(f.item.id, patch.own, `revision-${field}`), { kind: "sync_conflict", item: f.item.id });
      assert.ok(peer, "the real peer committed after the final package read");
      const settings = await sdk.readSettings(f.pmRoot);
      const located = await sdk.locateItem(f.pmRoot, f.item.id, settings.id_prefix, settings.item_format);
      assert.deepEqual((await sdk.readLocatedItem(located!, { schema: settings.schema })).document, peer, "refuse before any local lifecycle mutation");
      assert.equal((await sdk.readHistorySnapshot(sdk.getHistoryPath(f.pmRoot, f.item.id), f.item.id)).raw, history, "retain exactly the peer history");
      const retry = new Fence(sdk, f.pmRoot, "history-agent");
      await retry.capture(f.item.id);
      await retry.update(f.item.id, { description: "Fresh reviewed decision", force: true }, "revision-retry");
      assert.equal((await f.pm.get(f.item.id)).item.description, "Fresh reviewed decision");
    });
  }
});

test("decision-bound revision guards refuse unjournalled document edits and unchecked dispatch", async (t) => {
  for (const [name, Fence] of [["source", NativeWriteFence], ["built", BuiltNativeWriteFence]] as const) {
    for (const mode of ["document", "decision", "unchecked"]) await t.test(`${name}:${mode}`, async (sub) => {
      const f = await fixture(sub);
      const history = (await sdk.readHistorySnapshot(sdk.getHistoryPath(f.pmRoot, f.item.id), f.item.id)).raw;
      const fence = new Fence(sdk, f.pmRoot, "history-agent", async (id, options) => {
        if (mode === "unchecked") return;
        if (mode === "document") await peerWrite(f.pmRoot, id, { body: "Legacy peer body" }, "document");
        return f.pm.update(id, options);
      });
      await fence.capture(f.item.id);
      if (mode === "decision") await peerWrite(f.pmRoot, f.item.id, { body: "Legacy peer body" }, "document");
      await assert.rejects(fence.update(f.item.id, { title: "Must refuse" }, "revision-unchecked"), { kind: "sync_conflict", item: f.item.id });
      const item = (await f.pm.get(f.item.id, { depth: "full" })).item;
      assert.equal(item.title, "Initial");
      if (mode !== "unchecked") assert.equal(item.body, "Legacy peer body");
      assert.equal((await sdk.readHistorySnapshot(sdk.getHistoryPath(f.pmRoot, f.item.id), f.item.id)).raw, history);
    });
  }
});

test("owned mutation property rejects every additional in-process event even with copied attribution", async (t) => {
  for (const [name, Fence] of [["source", NativeWriteFence], ["built", BuiltNativeWriteFence]] as const) {
    for (const mode of ["title", "body", "assignee", "status", "parent", "dependencies", "audit", "aba", "noop", "noop-audit", "noop-aba", "close"]) {
      for (const phase of ["before", "after"]) for (const copyMessage of [false, true]) await t.test(`${name}:${mode}:${phase}:${copyMessage}`, async (sub) => {
        const f = await fixture(sub);
        const other = (await f.pm.create({ type: "Task", title: "Other endpoint" })).item;
        let peer: sdk.ItemDocument | undefined;
        const fence = new Fence(sdk, f.pmRoot, "history-agent", async (id, options) => {
          /** Commit a real peer inside the same inherited revision/provenance scope. */
          const interfere = async () => {
            const message = copyMessage ? options.message : undefined;
            if (mode === "audit" || mode === "noop-audit") await sdk.mutateItemWithHistoryContext({ pmRoot: f.pmRoot, settings: await sdk.readSettings(f.pmRoot),
              id, author: "history-agent", op: "update", message, historyContext: { peer_audit: true }, mutate: () => ({ changedFields: [] }) });
            else {
              const patches: Record<string, sdk.PmUpdateActionOptions> = {
                title: { title: "Peer title" }, body: { body: "Peer body" }, assignee: { assignee: "peer-agent" },
                status: { status: "blocked" }, parent: { parent: other.id }, dependencies: { dep: [`id=${other.id},kind=related`] },
                aba: { title: "Peer transient title" }, "noop-aba": { title: "Peer transient title" }, noop: { body: "Peer beside owned no-op" }, close: { body: "Peer beside owned close" },
              };
              await f.pm.update(id, { ...patches[mode]!, message });
              if (mode === "aba" || mode === "noop-aba") await f.pm.update(id, { title: "Initial", message });
            }
          };
          if (phase === "before") await interfere();
          const result = await f.pm.update(id, options);
          if (phase === "after") await interfere();
          const settings = await sdk.readSettings(f.pmRoot);
          const located = await sdk.locateItem(f.pmRoot, id, settings.id_prefix, settings.item_format);
          peer = (await sdk.readLocatedItem(located!, { schema: settings.schema })).document;
          return result;
        });
        await fence.capture(f.item.id);
        const head = fence.head(f.item.id);
        const own = mode.startsWith("noop") ? { title: "Initial" } : mode === "close" ?
          { title: "Owned terminal title", status: "closed", closeReason: "Owned close" } : { description: "Owned description" };
        await assert.rejects(fence.update(f.item.id, { ...own, force: true }, "in-process-property"), { kind: "sync_conflict" });
        assert.deepEqual(fence.head(f.item.id), head, "never adopt an event merely because it inherited attribution");
        assert.ok(peer);
        const history = (await sdk.readHistorySnapshot(sdk.getHistoryPath(f.pmRoot, f.item.id), f.item.id)).raw;
        const settings = await sdk.readSettings(f.pmRoot);
        const located = await sdk.locateItem(f.pmRoot, f.item.id, settings.id_prefix, settings.item_format);
        assert.deepEqual((await sdk.readLocatedItem(located!, { schema: settings.schema })).document, peer, "retain all durable effects without compensation");
        await assert.rejects(fence.update(f.item.id, { title: "Stale retry" }, "in-process-retry"), { kind: "sync_conflict" });
        assert.equal((await sdk.readHistorySnapshot(sdk.getHistoryPath(f.pmRoot, f.item.id), f.item.id)).raw, history);
      });
    }
  }
});

test("native receipts refuse peer substitutions of complete or pre-close intended mutations", async (t) => {
  for (const [name, Fence] of [["source", NativeWriteFence], ["built", BuiltNativeWriteFence]] as const) {
    for (const mode of ["title", "body", "close", "pre-close"]) await t.test(`${name}:${mode}`, async (sub) => {
      const f = await fixture(sub);
      const fence = new Fence(sdk, f.pmRoot, "history-agent", async (id, options) => {
        await f.pm.update(id, mode === "pre-close" ? { title: options.title, author: options.author, message: options.message } : options);
        return f.pm.update(id, options);
      });
      await fence.capture(f.item.id);
      const head = fence.head(f.item.id);
      const options = mode === "body" ? { body: "Intended body" } : mode === "title" ? { title: "Intended title" } :
        { title: "Intended title", status: "closed", closeReason: "Intended close" };
      await assert.rejects(fence.update(f.item.id, options, "peer-substitution"), { kind: "sync_conflict" });
      assert.deepEqual(fence.head(f.item.id), head);
      const item = (await f.pm.get(f.item.id, { depth: "full" })).item;
      if (mode === "body") assert.equal(item.body, "Intended body");
      else assert.equal(item.title, "Intended title");
      if (mode === "close" || mode === "pre-close") assert.equal(item.status, "closed");
      const history = (await sdk.readHistorySnapshot(sdk.getHistoryPath(f.pmRoot, f.item.id), f.item.id)).raw;
      await assert.rejects(fence.update(f.item.id, { title: "Stale retry" }, "peer-substitution-retry"), { kind: "sync_conflict" });
      assert.equal((await sdk.readHistorySnapshot(sdk.getHistoryPath(f.pmRoot, f.item.id), f.item.id)).raw, history);
    });
  }
});

test("semantic plans refuse genuine SDK receipts for different dispatched mutations", async (t) => {
  for (const [name, Fence] of [["source", NativeWriteFence], ["built", BuiltNativeWriteFence]] as const) {
    for (const mode of ["title", "missing-close-clocks"]) await t.test(`${name}:${mode}`, async (sub) => {
      const f = await fixture(sub);
      const fence = new Fence(sdk, f.pmRoot, "history-agent", (id, options) => f.pm.update(id, mode === "title" ?
        { ...options, title: "Different dispatched title" } : { ...options, status: "blocked", closeReason: undefined }));
      await fence.capture(f.item.id);
      const head = fence.head(f.item.id);
      await assert.rejects(fence.update(f.item.id, mode === "title" ? { title: "Intended title" } :
        { status: "closed", closeReason: "Intended close" }, "different-native-dispatch"), { kind: "sync_conflict" });
      assert.deepEqual(fence.head(f.item.id), head);
      const item = (await f.pm.get(f.item.id)).item;
      if (mode === "title") assert.equal(item.title, "Different dispatched title");
      else assert.equal(item.status, "blocked");
    });
  }
});

test("primary native errors survive failed diagnostic reads while missing-item conflicts still win", async (t) => {
  for (const [name, Fence] of [["source", NativeWriteFence], ["built", BuiltNativeWriteFence]] as const) {
    for (const primary of ["validation", "partial-close", "revision"]) for (const failure of ["history", "document", "replay", "missing"]) await t.test(`${name}:${primary}:${failure}`, async (sub) => {
      const f = await fixture(sub);
      const settings = await sdk.readSettings(f.pmRoot);
      if (primary === "partial-close") await sdk.writeSettings(f.pmRoot, { ...settings, governance: { ...settings.governance, preset: "custom", close_validation_default: "strict" } });
      const located = await sdk.locateItem(f.pmRoot, f.item.id, settings.id_prefix, settings.item_format);
      const historyPath = sdk.getHistoryPath(f.pmRoot, f.item.id), itemPath = located!.itemPath;
      let cause: unknown, displaced: string | undefined;
      const fence = new Fence(sdk, f.pmRoot, "history-agent", async (id, options) => {
        try {
          if (primary === "revision") await peerWrite(f.pmRoot, id, { body: "Unjournalled peer" }, "document");
          return await f.pm.update(id, options);
        } catch (error) {
          cause = error;
          if (failure === "history") { displaced = historyPath; renameSync(historyPath, `${historyPath}.saved`); mkdirSync(historyPath); }
          if (failure === "document" || failure === "missing") {
            displaced = itemPath; renameSync(itemPath, `${itemPath}.saved`);
            if (failure === "document") writeFileSync(itemPath, "invalid item fixture");
          }
          if (failure === "replay") {
            const current = (await sdk.readLocatedItem(located!, { schema: settings.schema })).document;
            // Append a corrupt new fixture record; never rewrite any existing audit record.
            await sdk.appendHistoryEntry(historyPath, sdk.createHistoryEntry({ author: "fixture-agent", op: "update",
              nowIso: new Date().toISOString(), before: sdk.emptyImportedDocument(), after: current }));
          }
          throw error;
        }
      });
      await fence.capture(f.item.id);
      const head = fence.head(f.item.id);
      try {
        const options = primary === "validation" ? { priority: 99 } : primary === "partial-close" ?
          { title: "Owned partial title", status: "closed", closeReason: "Strict refusal" } : { title: "Stale title" };
        await assert.rejects(fence.update(f.item.id, options, "diagnostic-refusal"), (error: unknown) => {
          assert.ok(cause instanceof Error);
          if (failure === "missing") assert.equal((error as NativeHistoryConflict).kind, "sync_conflict");
          else if (primary === "revision") {
            // The SDK enriches this error across its scope boundary; retain its original refusal facts.
            assert.equal((error as Error).message, cause.message);
            assert.equal((error as { code: string }).code, (cause as { code?: string }).code);
            for (const key of ["expected_revision", "current_revision"] as const) assert.equal((error as sdk.PmCliError).context?.[key], (cause as sdk.PmCliError).context?.[key]);
          } else assert.equal(error, cause, "diagnostic failure cannot replace the original write error");
          return true;
        });
        assert.deepEqual(fence.head(f.item.id), head);
      } finally {
        if (displaced !== undefined) { rmSync(displaced, { recursive: true, force: true }); renameSync(`${displaced}.saved`, displaced); }
      }
    });
  }
});

test("revision refusals remain conflicts when a document-only ABA restores the saved state", async (t) => {
  for (const [name, Fence] of [["source", NativeWriteFence], ["built", BuiltNativeWriteFence]] as const) await t.test(name, async (sub) => {
    const f = await fixture(sub);
    const settings = await sdk.readSettings(f.pmRoot), located = await sdk.locateItem(f.pmRoot, f.item.id, settings.id_prefix, settings.item_format);
    const before = (await sdk.readLocatedItem(located!, { schema: settings.schema })).document;
    let refusal: unknown;
    const fence = new Fence(sdk, f.pmRoot, "history-agent", async (id, options) => {
      await peerWrite(f.pmRoot, id, { body: "Transient unjournalled peer" }, "document");
      try { return await f.pm.update(id, options); }
      catch (error) {
        refusal = error;
        // The independent peer restores its own transient edit before diagnostics; the package never compensates.
        await peerWrite(f.pmRoot, id, { body: before.body }, "document");
        throw error;
      }
    });
    await fence.capture(f.item.id);
    const head = fence.head(f.item.id);
    await assert.rejects(fence.update(f.item.id, { title: "Must refuse" }, "revision-aba-refusal"), { kind: "sync_conflict" });
    assert.ok(sdk.isItemRevisionConflict(refusal));
    assert.deepEqual(fence.head(f.item.id), head);
    assert.deepEqual((await sdk.readLocatedItem(located!, { schema: settings.schema })).document, before);
  });
});

test("SDK phase plans preserve explicit lifecycle time corrections and normalized no-op inputs", async (t) => {
  for (const [name, Fence] of [["source", NativeWriteFence], ["built", BuiltNativeWriteFence]] as const) await t.test(name, async (sub) => {
    const f = await fixture(sub);
    const fence = new Fence(sdk, f.pmRoot, "history-agent");
    await fence.capture(f.item.id);
    await fence.update(f.item.id, { title: "  Native normalized title  ", tags: '["b","a","b"]' }, "normalized-control");
    const item = (await f.pm.get(f.item.id)).item;
    assert.equal(item.title, "Native normalized title");
    const head = fence.head(f.item.id);
    await fence.update(f.item.id, { title: item.title, tags: JSON.stringify(item.tags) }, "normalized-noop");
    assert.deepEqual(fence.head(f.item.id), head);
    await fence.update(f.item.id, { status: "closed", closeReason: "Owned completion" }, "close-control");
    await fence.update(f.item.id, { completedAt: "2026-01-01T00:00:00Z" }, "completion-correction");
    assert.equal((await f.pm.get(f.item.id)).item.completed_at, "2026-01-01T00:00:00.000Z");
    await fence.assertCurrent(f.item.id);
  });
});

test("phase ownership refuses swallowed close failures and mismatched pre-close event kinds", async (t) => {
  for (const [name, Fence] of [["source", NativeWriteFence], ["built", BuiltNativeWriteFence]] as const) {
    for (const mode of ["swallowed", "wrong-kind"]) await t.test(`${name}:${mode}`, async (sub) => {
      const f = await fixture(sub), settings = await sdk.readSettings(f.pmRoot);
      await sdk.writeSettings(f.pmRoot, { ...settings, governance: { ...settings.governance, preset: "custom", close_validation_default: "strict" } });
      const fence = new Fence(sdk, f.pmRoot, "history-agent", async (id, options) => {
        if (mode === "wrong-kind") {
          await sdk.mutateItemWithHistoryContext({ pmRoot: f.pmRoot, settings: await sdk.readSettings(f.pmRoot), id,
            author: "history-agent", op: "restore", mutate: (document) => { document.metadata.title = options.title!; return { changedFields: ["title"] }; } });
          throw new Error("Synthetic failure after non-update peer event");
        }
        try { return await f.pm.update(id, options); } catch { return undefined; }
      });
      await fence.capture(f.item.id);
      const head = fence.head(f.item.id);
      await assert.rejects(fence.update(f.item.id, { title: "Owned partial title", status: "closed", closeReason: "Strict close" }, "unverified-phase"), { kind: "sync_conflict" });
      assert.deepEqual(fence.head(f.item.id), head);
      assert.equal((await f.pm.get(f.item.id)).item.title, "Owned partial title");
      assert.equal((await f.pm.get(f.item.id)).item.status, "open");
    });
  }
});

test("owned partial close failures preserve validation errors and reject peer suffixes", async (t) => {
  for (const [name, Fence] of [["source", NativeWriteFence], ["built", BuiltNativeWriteFence]] as const) {
    for (const mode of ["owned", "peer", "aba", "document", "same-author", "same-message", "legacy"]) await t.test(`${name}:${mode}`, async (sub) => {
      const f = await fixture(sub);
      const settings = await sdk.readSettings(f.pmRoot);
      await sdk.writeSettings(f.pmRoot, { ...settings, governance: { ...settings.governance, preset: "custom", close_validation_default: "strict" } });
      let cause: unknown;
      const fence = new Fence(sdk, f.pmRoot, "history-agent", async (id, options) => {
        try { return await f.pm.update(id, options); }
        catch (error) {
          cause = error;
          if (mode === "peer" || mode === "aba") await peerWrite(f.pmRoot, id, { title: "Peer after failure" });
          if (mode === "aba") await peerWrite(f.pmRoot, id, { title: "Owned partial title" });
          if (mode === "same-author" || mode === "same-message") await peerWrite(f.pmRoot, id, { author: "history-agent", title: "Same-author peer", ...(mode === "same-message" ? { message: options.message } : {}) });
          if (mode === "legacy") await peerWrite(f.pmRoot, id, { title: "Legacy peer", message: options.message }, "legacy");
          if (mode === "document") await peerWrite(f.pmRoot, id, { body: "Unjournalled peer" }, "document");
          throw error;
        }
      });
      await fence.capture(f.item.id);
      const head = fence.head(f.item.id);
      await assert.rejects(fence.update(f.item.id, { title: "Owned partial title", status: "closed", closeReason: "Close attempt" }, "partial-close"), (error: unknown) => {
        assert.ok(cause instanceof Error, `native cause missing; observed ${String(error)}`);
        assert.match(cause.message, /strict|resolution|expected.result/iu);
        if (mode === "owned") assert.equal(error, cause, "preserve the exact native validation error");
        else assert.equal((error as NativeHistoryConflict).kind, "sync_conflict");
        return true;
      });
      assert.deepEqual(fence.head(f.item.id), head, "partial failure never adopts a baseline");
      const item = (await f.pm.get(f.item.id)).item;
      assert.equal(item.title, mode === "peer" ? "Peer after failure" : mode.startsWith("same-") ? "Same-author peer" : mode === "legacy" ? "Legacy peer" : "Owned partial title");
      assert.equal(item.status, "open", "the strict close did not commit");
      const history = await sdk.readHistorySnapshot(sdk.getHistoryPath(f.pmRoot, f.item.id), f.item.id);
      assert.ok(history.entries.length > head.length, "the owned field update really committed before refusal");
      await assert.rejects(fence.update(f.item.id, { title: "Retry" }, "partial-retry"), { kind: "sync_conflict" });
      assert.equal((await sdk.readHistorySnapshot(sdk.getHistoryPath(f.pmRoot, f.item.id), f.item.id)).raw, history.raw);
    });
  }
});

test("combined field and close success advances every owned native event", async (t) => {
  for (const [name, Fence] of [["source", NativeWriteFence], ["built", BuiltNativeWriteFence]] as const) await t.test(name, async (sub) => {
    const f = await fixture(sub);
    const fence = new Fence(sdk, f.pmRoot, "history-agent");
    await fence.capture(f.item.id);
    const head = fence.head(f.item.id);
    await fence.update(f.item.id, { title: "Owned terminal title", status: "closed", closeReason: "Combined close" }, "combined-close");
    const item = (await f.pm.get(f.item.id)).item;
    assert.equal(item.title, "Owned terminal title");
    assert.equal(item.status, "closed");
    assert.ok(fence.head(f.item.id).length >= head.length + 2);
    await fence.assertCurrent(f.item.id);
  });
});

test("successful owned dispatch refuses an unjournalled post-write edit", async (t) => {
  for (const [name, Fence] of [["source", NativeWriteFence], ["built", BuiltNativeWriteFence]] as const) await t.test(name, async (sub) => {
    const f = await fixture(sub);
    const fence = new Fence(sdk, f.pmRoot, "history-agent", async (id, options) => {
      const result = await f.pm.update(id, options);
      await peerWrite(f.pmRoot, id, { body: "Post-write peer" }, "document");
      return result;
    });
    await fence.capture(f.item.id);
    const head = fence.head(f.item.id);
    await assert.rejects(fence.update(f.item.id, { title: "Owned title" }, "post-write-peer"), { kind: "sync_conflict" });
    assert.deepEqual(fence.head(f.item.id), head);
    assert.equal((await f.pm.get(f.item.id)).item.title, "Owned title");
    await assert.rejects(fence.update(f.item.id, { body: "Stale" }, "post-write-retry"), (error: unknown) => {
      assert.deepEqual((error as NativeHistoryConflict).fields.body, { base: "", current: "Post-write peer" });
      return true;
    });
  });
});

test("unchecked host dispatch reports read-back fields without adopting its baseline", async (t) => {
  for (const [name, Fence] of [["source", NativeWriteFence], ["built", BuiltNativeWriteFence]] as const) {
    for (const writes of [false, true]) await t.test(`${name}:${writes ? "write" : "no-op"}`, async (sub) => {
      const f = await fixture(sub);
      const fence = new Fence(sdk, f.pmRoot, "history-agent", async (id) => {
        if (writes) await peerWrite(f.pmRoot, id, { body: "Adapter body" }, "document");
      });
      await fence.capture(f.item.id);
      const head = fence.head(f.item.id);
      await assert.rejects(fence.update(f.item.id, { title: "Unchecked title" }, "unchecked-evidence"), (error: unknown) => {
        assert.ok(error instanceof Error);
        const conflict = error as NativeHistoryConflict;
        assert.equal(conflict.kind, "sync_conflict");
        assert.match(conflict.message, /dispatch completed without a revision check/u);
        assert.deepEqual(conflict.fields, writes ? { body: { base: "", current: "Adapter body" } } : {});
        return true;
      });
      assert.deepEqual(fence.head(f.item.id), head);
      assert.equal((await f.pm.get(f.item.id)).item.title, "Initial");
      if (writes) await assert.rejects(fence.update(f.item.id, { body: "Adapter body" }, "unchecked-retry"), (error: unknown) => {
        assert.deepEqual((error as NativeHistoryConflict).fields.body, { base: "", current: "Adapter body" });
        return true;
      });
    });
  }
});

test("decision-bound revision guards advance own lifecycle writes but refuse the next peer revision", async (t) => {
  for (const [name, Fence] of [["source", NativeWriteFence], ["built", BuiltNativeWriteFence]] as const) await t.test(name, async (sub) => {
    const f = await fixture(sub);
    let history: string | null | undefined;
    const fence = new Fence(sdk, f.pmRoot, "history-agent", async (id, options) => {
      await f.pm.update(id, { ...options, status: "closed", closeReason: "Owned close", title: "Owned title" });
      await f.pm.update(id, { ...options, description: "Owned follow-up", title: "Owned title" });
      await peerWrite(f.pmRoot, id, { title: "Peer after own writes" });
      history = (await sdk.readHistorySnapshot(sdk.getHistoryPath(f.pmRoot, id), id)).raw;
      return f.pm.update(id, options);
    });
    await fence.capture(f.item.id);
    await assert.rejects(fence.update(f.item.id, { title: "Stale final title" }, "revision-own-advance"), { kind: "sync_conflict", item: f.item.id });
    const item = (await f.pm.get(f.item.id)).item;
    assert.equal(item.status, "closed", "successful owned close is retained");
    assert.equal(item.description, "Owned follow-up", "scope advances for the second owned write");
    assert.equal(item.title, "Peer after own writes", "the third write cannot adopt an ordinary peer");
    assert.equal((await sdk.readHistorySnapshot(sdk.getHistoryPath(f.pmRoot, f.item.id), f.item.id)).raw, history);
  });
});

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
    await peerWrite(f.pmRoot, a.id, { parent: id }); // This is valid only while X remains under B.
    await peerWrite(f.pmRoot, id, { title: "Peer title" });
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
      if (peer) await peerWrite(f.pmRoot, id, { title: "Peer before SDK refusal" });
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

test("all captured heads stay fenced when a later item changes outside the current selection", async (t) => {
  for (const [name, Fence] of [["source", NativeWriteFence], ["built", BuiltNativeWriteFence]] as const) await t.test(name, async (sub) => {
    const f = await fixture(sub), other = (await f.pm.create({ type: "Task", title: "Other captured item" })).item;
    const fence = new Fence(sdk, f.pmRoot, "history-agent");
    await fence.assertAll();
    await fence.capture(f.item.id); await fence.capture(other.id);
    const heads = [fence.head(f.item.id), fence.head(other.id)];
    await fence.assertAll();
    await f.pm.update(other.id, { body: "Peer changed the later captured item" });
    await assert.rejects(fence.assertAll(), { kind: "sync_conflict", item: other.id });
    assert.deepEqual([fence.head(f.item.id), fence.head(other.id)], heads);
    assert.equal((await f.pm.get(other.id, { depth: "full" })).item.body, "Peer changed the later captured item");
  });
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
