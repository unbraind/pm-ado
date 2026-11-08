/** Guard the delivered statement-enforcement record through real native tracker reads. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync } from "node:fs";
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
  const { item } = await pm.get(id, { full: true });
  const historyPath = join(pmRoot, "history", `${id}.jsonl`);
  // The 17 events before PR 44 are immutable evidence, independently pinned from
  // commit 42170123973a632f51fbcbb128823583c9315c5a at
  // .agents/pm/history/pm-ado-5w3m.jsonl.
  // Hash raw bytes: SDK validation and latest-value checks cannot prove that an
  // older event was never rewritten. Later corrective/appended events are allowed.
  const priorBytes = readFileSync(historyPath).subarray(0, 27_087);
  assert.equal(priorBytes.length, 27_087, "pre-PR-44 history must not be truncated");
  assert.equal(createHash("sha256").update(priorBytes).digest("hex"),
    "1c004298e4879ab71a2447b6e5a4c57b174a66a9df6bc1768707820a8c99621a",
    "pre-PR-44 history must remain a byte-identical prefix");
  const history = await readHistoryEntries(historyPath, id);
  const delivery = "https://github.com/unbraind/pm-ado/pull/19";
  const merge = "f297a71431debfe2e00adb8dd1b02874e6dadfe2";
  const mergedAt = "2026-10-08T01:19:51Z";
  assert.equal(item.status, "closed");
  assert.equal(item.completed_at, "2026-10-08T01:19:51.000Z");
  assert.match(item.resolution ?? "", /PR 16 only recorded the gap and is not the delivery/u);
  for (const field of ["actual_result", "close_reason"] as const) {
    const value = item[field] ?? "";
    assert.equal(value.split(": ", 1)[0], `${delivery}, merged ${mergedAt}, merge ${merge}`,
      `${field} must identify the exact delivery URL, merge and time`);
  }
  for (const field of ["completed_at", "resolution", "actual_result", "close_reason"] as const) {
    const lastWrite = history.flatMap((event) => event.patch).filter((patch) => patch.path === `/metadata/${field}`).at(-1);
    assert.ok(lastWrite && "value" in lastWrite, `history must retain ${field}`);
    assert.equal(lastWrite.value, item[field], `history and record must agree on ${field}`);
  }
  const close = history.filter((event) => event.op === "close").at(-1);
  assert.ok(close, "native close evidence must remain in history");
  for (const field of ["actual_result", "close_reason"] as const) {
    const patch: NativeHistoryPatch | undefined = close.patch.find((entry) => entry.path === `/metadata/${field}`);
    assert.ok(patch && "value" in patch);
    assert.equal(patch.value, item[field], `close evidence must identify the same ${field}`);
  }
});
