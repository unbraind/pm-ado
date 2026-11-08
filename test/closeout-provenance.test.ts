/** Guard the delivered statement-enforcement record through real native tracker reads. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { PmClient, readHistoryEntries } from "@unbrained/pm-cli/sdk";
import { fixtureDirectory, packageRoot } from "./helpers/package-runtime.ts";

/** One patch returned by the SDK's validated native history reader. */
type NativeHistoryPatch = Awaited<ReturnType<typeof readHistoryEntries>>[number]["patch"][number];

test("statement enforcement delivery record and history identify PR 19, not the earlier gap report", async (t) => {
  const { root, cleanup } = fixtureDirectory("ado-closeout-provenance-");
  t.after(cleanup);
  const pmRoot = join(root, ".agents/pm");
  const pm = new PmClient({ cwd: root, pmRoot, author: "fixture-agent" });
  await pm.init("pm-ado");
  const id = "pm-ado-5w3m";
  for (const path of [`issues/${id}.toon`, `history/${id}.jsonl`]) {
    cpSync(join(packageRoot, ".agents/pm", path), join(pmRoot, path));
  }
  assert.equal(existsSync(join(root, ".git")), false, "provenance reads must work without git");
  const historyPath = join(pmRoot, "history", `${id}.jsonl`);
  await verifyDelivery(pm, id, historyPath);
  const { item: original } = await pm.get(id, { full: true });
  for (const field of ["resolution", "actual_result", "close_reason"] as const) {
    await t.test(`reject contradictory ${field} even with matching history`, async () => {
      await pm.reopen(id, "Adversarial matching close fixture");
      await pm.close(id, field === "close_reason" ? `${original.close_reason} Delivered by PR 20.` : original.close_reason ?? "", {
        resolution: field === "resolution" ? `${original.resolution} Delivered by PR 20.` : original.resolution,
        actualResult: field === "actual_result" ? `${original.actual_result} Delivered by PR 20.` : original.actual_result,
        completedAt: original.completed_at,
      });
      await assert.rejects(verifyDelivery(pm, id, historyPath));
      await pm.reopen(id, "Restore fixture delivery");
      await pm.close(id, original.close_reason ?? "", {
        resolution: original.resolution, actualResult: original.actual_result, completedAt: original.completed_at,
      });
      await verifyDelivery(pm, id, historyPath);
    });
  }
  await t.test("pin every historical event through the correction while permitting appends", async () => {
    const baseline = readFileSync(historyPath, "utf8");
    const lines = baseline.split("\n");
    try {
      for (let index = 0; index < 19; index += 1) {
        const changed = [...lines];
        changed[index] += " "; // Valid JSON and unchanged event hashes, different immutable bytes.
        writeFileSync(historyPath, changed.join("\n"));
        await assert.rejects(verifyDelivery(pm, id, historyPath), /byte-identical prefix/u);
      }
    } finally {
      writeFileSync(historyPath, baseline);
    }
    await verifyDelivery(pm, id, historyPath);
  });
  await t.test("reject a wrong close resolution followed by a correct update", async () => {
    await pm.reopen(id, "Adversarial fixture");
    await pm.close(id, original.close_reason ?? "", { resolution: "Delivered by PR 16", actualResult: original.actual_result, completedAt: original.completed_at });
    await pm.update(id, { resolution: original.resolution, completedAt: original.completed_at });
    await assert.rejects(verifyDelivery(pm, id, historyPath), /close evidence/u);
  });
});

/** Compare every delivery-bearing value and the immutable correction prefix in a non-git tracker. */
async function verifyDelivery(pm: PmClient, id: string, historyPath: string): Promise<void> {
  const { item } = await pm.get(id, { full: true });
  // The 19 events through PR 44 are immutable evidence, independently pinned from
  // commit 9f7158b at
  // .agents/pm/history/pm-ado-5w3m.jsonl.
  // Hash raw bytes: SDK validation and latest-value checks cannot prove that an
  // older event was never rewritten. Later corrective/appended events are allowed.
  const priorBytes = readFileSync(historyPath).subarray(0, 31_248);
  assert.equal(priorBytes.length, 31_248, "PR-44 history must not be truncated");
  assert.equal(createHash("sha256").update(priorBytes).digest("hex"),
    "46de7573d99a475f4c74f09767231412fed43e6c96299854a5d614a2c6f3d170",
    "PR-44 history must remain a byte-identical prefix");
  const history = await readHistoryEntries(historyPath, id);
  const delivery = "https://github.com/unbraind/pm-ado/pull/19";
  const merge = "f297a71431debfe2e00adb8dd1b02874e6dadfe2";
  const mergedAt = "2026-10-08T01:19:51Z";
  assert.equal(item.status, "closed");
  assert.equal(item.completed_at, "2026-10-08T01:19:51.000Z");
  const resolution = "Independently measures executable statements and enforces the declared statement threshold; PR 16 only recorded the gap and is not the delivery.";
  assert.equal(item.resolution, resolution);
  for (const field of ["actual_result", "close_reason"] as const) {
    const value = item[field] ?? "";
    assert.equal(value, `${delivery}, merged ${mergedAt}, merge ${merge}: ${resolution}`,
      `${field} must identify the exact delivery URL, merge and time`);
  }
  for (const field of ["completed_at", "resolution", "actual_result", "close_reason"] as const) {
    const lastWrite = history.flatMap((event) => event.patch).filter((patch) => patch.path === `/metadata/${field}`).at(-1);
    assert.ok(lastWrite && "value" in lastWrite, `history must retain ${field}`);
    assert.equal(lastWrite.value, item[field], `history and record must agree on ${field}`);
  }
  const close = history.filter((event) => event.op === "close").at(-1);
  assert.ok(close, "native close evidence must remain in history");
  for (const field of ["resolution", "actual_result", "close_reason"] as const) {
    const patch: NativeHistoryPatch | undefined = close.patch.find((entry) => entry.path === `/metadata/${field}`);
    assert.ok(patch && "value" in patch);
    assert.equal(patch.value, item[field], `close evidence must identify the same ${field}`);
  }
}
