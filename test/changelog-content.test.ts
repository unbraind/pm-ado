/** Package changelog membership and child-preloader regressions, independent of release orchestration. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { devNull, tmpdir } from "node:os";
import test from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { fixtureDirectory, packageRoot } from "./helpers/package-runtime.ts";
import { assertTargetPreloaded, fixtureProcessTimeoutMs, relocateNodePreloads, runCommand } from "./helpers/process-fixture.ts";

test("changelog generation records breaking API changes before publish", () => {
  const scripts = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf-8")).scripts as Record<string, string>;
  const generators = ["changelog", "changelog:full", "changelog:check", "release:notes"];
  for (const name of generators) {
    assert.match(scripts[name], /^pm-changelog --/, name);
    assert.match(scripts[name], /--breaking-changes/, name);
  }
});

for (const timing of ["before", "after"] as const) {
  test(`changelog:full keeps an omitted ${timing}-tag delivery exclusively in Unreleased`, async (t) => {
    const { root, cleanup } = fixtureDirectory("ado-unreleased-content-");
    t.after(cleanup);
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      version: string; scripts: Record<string, string>;
    };
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "changelog-content-fixture", version: pkg.version,
      scripts: { "changelog:full": pkg.scripts["changelog:full"] },
    }));
    symlinkSync(join(packageRoot, "node_modules"), join(root, "node_modules"), "junction");
    const childEnv = { ...process.env };
    if (childEnv.NODE_OPTIONS) childEnv.NODE_OPTIONS = relocateNodePreloads(childEnv.NODE_OPTIONS, packageRoot);
    // Preserve Node options and statement-preloader settings for spawned CLI coverage.
    for (const key of Object.keys(childEnv)) {
      if (/token|secret|password|credential|api.?key|authorization/iu.test(key) ||
        /^(?:GIT_|NPM_MEDIA_SERVER$|npm_config_)/iu.test(key)) delete childEnv[key];
    }
    Object.assign(childEnv, {
      NPM_CONFIG_USERCONFIG: devNull, npm_config_userconfig: devNull,
      PM_AUTHOR: "fixture-agent",
      GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_DATE: timing === "before" ? "2099-01-01T00:00:00Z" : "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: timing === "before" ? "2099-01-01T00:00:00Z" : "2000-01-01T00:00:00Z",
    });
    const pm = new PmClient({ cwd: root, pmRoot: join(root, ".agents/pm"), author: "fixture-agent" });
    await pm.init("fixture");
    const { item: seed } = await pm.create({ title: "Included release seed", type: "Task" });
    await pm.close(seed.id, "Seed delivery verified");
    const title = `Pending fixture delivery ${timing} the tagged release`;
    if (timing === "before") {
      const { item } = await pm.create({ title, type: "Task" });
      await pm.close(item.id, "Fixture implementation verified");
    }
    for (const args of [
      ["init", "--initial-branch=main"], ["add", "package.json", ".agents/pm"],
      // Commit a tracker-bearing snapshot, deliberately excluding the omitted item.
      ...(timing === "before" ? [["reset", "--", ".agents/pm/tasks", ".agents/pm/history"], ["add", `.agents/pm/tasks/${seed.id}.toon`, `.agents/pm/history/${seed.id}.jsonl`]] : []),
      ["-c", "user.name=SteveBot", "-c", "user.email=1153461+unbraind@users.noreply.github.com", "commit", "-m", "Fixture release"],
      ["tag", `v${pkg.version}`],
    ]) await runCommand("git", args, { cwd: root, env: childEnv });
    if (timing === "after") {
      const { item } = await pm.create({ title, type: "Task" });
      await pm.close(item.id, "Fixture implementation verified");
    }
    await runCommand(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "changelog:full"], {
      cwd: root, env: childEnv, shell: process.platform === "win32", timeout: 60_000,
    });
    const generated = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    const unreleased = generated.split(/^## /mu).find((section) => /^Unreleased\r?\n/u.test(section));
    assert.ok(unreleased, "regeneration must retain an Unreleased section after a tagged release");
    assert.ok(unreleased.includes(title), "the pending delivery must remain inside Unreleased");
    assert.ok(generated.includes(`## ${pkg.version} - `), "the tagged release must also remain present");
    const tagged = generated.split(/^## /mu).find((section) => section.startsWith(`${pkg.version} - `));
    assert.ok(tagged);
    if (timing === "before") {
      assert.ok(tagged.includes(seed.title), "the included seed must remain in the tagged release");
      assert.ok(!unreleased.includes(seed.title), "the included seed must not leak into Unreleased");
    }
    assert.ok(!tagged.includes(title), "pending delivery must not also appear in the tagged release");
  });
}

test("relocated children preserve every supported relative preload spelling", async (t) => {
  const { root, cleanup } = fixtureDirectory("ado-preload-");
  t.after(cleanup);
  writeFileSync(join(root, "probe.cjs"), "globalThis.fixturePreloaded = true;");
  writeFileSync(join(root, "probe space.cjs"), "globalThis.fixturePreloaded = true;");
  for (const flag of ["--import", "--require", "-r"]) {
    for (const separator of flag === "-r" ? [" "] : ["=", " "]) {
      for (const path of ["./probe.cjs", '"./probe.cjs"', '"./probe space.cjs"', `../${basename(root)}/probe.cjs`]) {
        const options = relocateNodePreloads(`--no-warnings ${flag}${separator}${path}`, root);
        assert.ok(options.startsWith("--no-warnings "));
        await runCommand(process.execPath, ["-e", "if (!globalThis.fixturePreloaded) process.exit(1)"], {
          cwd: packageRoot, env: { NODE_OPTIONS: options },
        });
      }
    }
  }
  const untouched = String.raw`--no-warnings --import=node:fs --require=module --require="C:\preload.cjs"`;
  assert.equal(relocateNodePreloads(untouched, root), untouched);
});

/** Relocation must work in every host fixture, including installed CLI JSON/TOON consumers. */
test("relative preloads survive every installed host fixture cwd change", async (t) => {
  const root = mkdtempSync(join(packageRoot, "test/.preload-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const probe = join(root, "probe.cjs");
  const receipts = join(root, "receipts.jsonl");
  // Receipt paths are recorded realpath-resolved at load time, so temporary-directory
  // aliases (/var versus /private/var, or a symlinked TMPDIR) never hide a consumer
  // receipt, and every later comparison stays a pure string check on canonical paths.
  writeFileSync(probe, `const { appendFileSync, realpathSync } = require("node:fs");
const { isAbsolute } = require("node:path");
const resolved = (value) => { if (!isAbsolute(value)) return value; try { return realpathSync(value); } catch { return value; } };
appendFileSync(${JSON.stringify(receipts)}, JSON.stringify({ cwd: resolved(process.cwd()), argv: process.argv.map(resolved) }) + "\\n");`);
  // Regression: run the consumer fixture under a symlinked temporary-directory alias
  // so the recorded consumer paths actually cross an alias on every POSIX host.
  const aliasedTmp = process.platform === "win32" ? undefined : join(root, "tmpdir-alias");
  if (aliasedTmp) symlinkSync(tmpdir(), aliasedTmp, "junction");
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (/token|secret|password|credential|api.?key|authorization|^NODE_TEST_/iu.test(key)) delete childEnv[key];
  }
  childEnv.NODE_OPTIONS = `${relocateNodePreloads(childEnv.NODE_OPTIONS ?? "", packageRoot)} --import=${JSON.stringify(`./${relative(packageRoot, probe)}`)}`;
  for (const [file, pattern] of [
    ["test/changelog-content.test.ts", "changelog:full keeps an omitted"],
    ["test/sync.test.ts", "actual CLI import/export/sync apply"],
    ["test/moves.test.ts", "installed no-git CLI and SDK command"],
    ["test/prepare-merge-driver.test.ts", "a full install registers every merge driver|an invalid global lookup path preserves the installer failure"],
    ["test/contracts.test.ts", "non-git command previews complete SDK values"],
    ["test/refresh.test.ts", "round-6 SDK and copied CLI JSON TOON"],
    ["test/public-api.test.ts", "unchanged published consumer compiles"],
  ]) {
    writeFileSync(receipts, "");
    const result = await runCommand(process.execPath, ["--test", "--test-concurrency=1", `--test-name-pattern=${pattern}`, file], {
      cwd: packageRoot,
      env: file === "test/public-api.test.ts" && aliasedTmp ? { ...childEnv, TMPDIR: aliasedTmp } : childEnv,
      timeout: fixtureProcessTimeoutMs,
    });
    assert.match(result.stdout, /(?:# tests|ℹ tests) [1-9]/u, `${file} must execute its selected acceptance test`);
    assert.match(result.stdout, /(?:# pass|ℹ pass) [1-9]/u, `${file} must pass a selected acceptance test`);
    const loaded = readFileSync(receipts, "utf8").trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { cwd: string; argv: string[] });
    const targetEntry = file === "test/changelog-content.test.ts" ? /(?:[/\\]pm-changelog|[/\\]pm-changelog[/\\].*cli\.js)$/u
      : file === "test/prepare-merge-driver.test.ts" ? /[/\\]prepare-merge-driver\.ts$/u
      : file === "test/public-api.test.ts" ? /[/\\]consumer\.mjs$/u : /[/\\]cli\.js$/u;
    assert.ok(loaded.some((receipt) => relative(packageRoot, receipt.cwd) !== "" && targetEntry.test(receipt.argv[1] ?? "")),
      `${file}: the relocated target entry point must observably load the inherited probe`);
    if (["test/moves.test.ts", "test/contracts.test.ts", "test/refresh.test.ts"].includes(file)) {
      for (const format of [["--json"], ["--output-format", "toon"]]) {
        const target = loaded.find((receipt) => relative(packageRoot, receipt.cwd) !== "" &&
          targetEntry.test(receipt.argv[1] ?? "") &&
          JSON.stringify(receipt.argv.slice(-format.length)) === JSON.stringify(format));
        assert.ok(target, `${file}: ${format.join(" ")} must independently load the inherited probe`);
        assertTargetPreloaded(receipts, 0, target.cwd, targetEntry, target.argv.slice(2));
      }
    }
    if (file === "test/public-api.test.ts") {
      for (const mode of ["built", "published"]) {
        const consumer = loaded.find((receipt) => basename(receipt.cwd) === "consumer" &&
          receipt.argv[1] === join(receipt.cwd, `out-${mode}/consumer.mjs`) &&
          basename(receipt.argv[2] ?? "") === `${mode}-node`);
        assert.ok(consumer, `${mode}: the Node consumer entry point must load the probe`);
        assertTargetPreloaded(receipts, 0, consumer.cwd, /[/\\\\]consumer\.mjs$/u, consumer.argv.slice(2));
      }
    }
    if (file === "test/prepare-merge-driver.test.ts") {
      for (const fixture of process.platform === "win32" ? ["invalid-global-path"] : ["full", "invalid-global-path"]) {
        assert.ok(loaded.some((receipt) => basename(receipt.cwd) === fixture && targetEntry.test(receipt.argv[1] ?? "")),
          `prepare fixture ${fixture} must load the probe through its own child environment`);
      }
    }
  }
});
