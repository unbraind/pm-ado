/** Protect disposable differential inputs and keep the documented SDK pin accurate. */
import assert from "node:assert/strict";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { fixtureDirectory, packageRoot } from "./helpers/package-runtime.ts";
import { runCommand } from "./helpers/process-fixture.ts";

test("differential refuses outward history symlinks before writing source targets", async (t) => {
  const { root, cleanup } = fixtureDirectory("ado-differential-links-");
  t.after(cleanup);
  const tracker = join(root, "tracker"), target = join(root, "original.jsonl");
  const pm = new PmClient({ cwd: root, pmRoot: tracker, author: "fixture-agent" });
  await pm.run("init", { prefix: "fixture" });
  const { item } = await pm.create({ title: "Public differential fixture", type: "Task" });
  const history = join(tracker, "history", `${item.id}.jsonl`);
  const bytes = await readFile(history);
  await writeFile(target, bytes);
  await rm(history);
  await symlink(target, history);
  try {
    await assert.rejects(runCommand(process.execPath, [join(packageRoot, "scripts/sdk-adoption-differential.ts"), packageRoot, tracker, tracker],
      { timeout: 60_000 }), /Tracker symlink escapes source snapshot/u);
  } finally { assert.deepEqual(await readFile(target), bytes); }
});

test("SDK adoption docs identify the package's pinned SDK version", async () => {
  const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { devDependencies: Record<string, string> };
  const pinned = pkg.devDependencies["@unbrained/pm-cli"];
  for (const name of ["conflict-resolution", "sdk-adoption"]) {
    const doc = await readFile(join(packageRoot, `docs/${name}.md`), "utf8");
    assert.ok(doc.includes(`pinned SDK (${pinned})`), `${name} must identify the current SDK pin`);
  }
});
