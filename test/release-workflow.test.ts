import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { devNull, tmpdir } from "node:os";
import test from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { fixtureDirectory, packageRoot } from "./helpers/package-runtime.ts";
import { assertTargetPreloaded, fixtureProcessTimeoutMs, relocateNodePreloads, runCommand } from "./helpers/process-fixture.ts";
import { caller, callerSource, canonicalRelease, executable, releaseStep } from "./helpers/release-caller.ts";

test("npm publication authenticates by OIDC, with no stored token anywhere in the workflow", async () => {
  const { jobs } = await canonicalRelease();
  const source = [callerSource, JSON.stringify(jobs)].join("\n");
  assert.doesNotMatch(source, /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\.NPM/u);
});

test("the release job effectively holds id-token: write, and no comment can stand in for it", async () => {
  const { jobs } = await canonicalRelease();
  assert.equal(caller.jobs.release.permissions["id-token"], "write");
  assert.deepEqual(caller.permissions, {});
  assert.equal(jobs.release.permissions["id-token"], "write");
  assert.equal(jobs.request.permissions["id-token"], "write");
  assert.equal(jobs.prepare.permissions["id-token"], undefined);
});

test("reconciliation resumes the exact candidate before admitting preparation or publication", async () => {
  const { jobs } = await canonicalRelease();
  const probe = releaseStep(jobs.reconcile, "Reconcile durable release intent");
  assert.equal(probe.run, 'node "$CONTINUATION_SCRIPT" probe');
  assert.match(jobs.prepare.if, /needs\.reconcile\.outputs\.pending == 'false'/u);
  const approval = releaseStep(jobs.reconcile, "Approve currently waiting release CI once");
  assert.equal(approval.if, "steps.probe.outputs.action == 'pending'");
  assert.equal(approval.env?.RELEASE_COMMIT, "${{ steps.probe.outputs.headSha }}");
  assert.match(approval.run, /^node "\$CONTINUATION_SCRIPT" approve$/mu);
  const request = releaseStep(jobs.request, "Merge release metadata through protected PR");
  assert.match(request.run, /node "\$CONTINUATION_SCRIPT" request/u);
  assert.doesNotMatch(executable(request.run), /awaiting_approval|\bsleep\b/u);
  const verify = releaseStep(jobs.release, "Revalidate trusted merged candidate");
  assert.equal(verify.run, 'node "$CONTINUATION_SCRIPT" verify');
  const steps = jobs.release.steps;
  const verified = steps.findIndex(step => step.name === verify.name);
  const published = steps.findIndex(step => step.name === "Publish npm package");
  const tagged = steps.findIndex(step => step.name === "Push release tag");
  assert.ok(verified >= 0 && verified < published && published < tagged);
});

const npmBootstrap = "Use an npm that supports trusted publishing";

/** Require an exact job-local npm bootstrap and return its version. */
function pinnedNpm(script: string): string {
  const install = /^npm install --prefix "\$RUNNER_TEMP\/npm-(\d+\.\d+\.\d+)" npm@\1(?=\s|$)/mu.exec(script);
  assert.ok(install, "the job must install an exact npm version into its own prefix");
  return install[1];
}

/** Only the pinned bootstrap directory may be written to GITHUB_PATH once. */
function assertOnlyPinnedPathWrite(script: string, version: string): void {
  const approved = 'echo "$RUNNER_TEMP/npm-' + version + '/node_modules/.bin" >> "$GITHUB_PATH"';
  assert.ok(script.split("\n").includes(approved), "the bootstrap must publish its pinned bin directory");
  assert.doesNotMatch(script.replace(approved, ""), /GITHUB_PATH/u);
}

test("the npm upgrade cannot be skipped and fails closed on the version it actually gets", async () => {
  const { jobs } = await canonicalRelease();
  for (const job of [jobs.prepare, jobs.release]) {
    const upgrade = releaseStep(job, npmBootstrap);
    const script = executable(upgrade.run);
    const version = pinnedNpm(script);
    assert.equal(upgrade.if, undefined);
    assert.equal(upgrade["continue-on-error"], undefined);
    assert.match(script, /^set -euo pipefail$/mu);
    assert.ok(script.includes('export PATH="$RUNNER_TEMP/npm-' + version + '/node_modules/.bin:$PATH"'));
    assert.match(script, /npm --version/u);
    assert.ok(script.includes('[[ "$active" == "' + version + '" ]]'));
    assert.match(script, /sort -V/u);
    assert.match(script, /exit 1/u);
    assert.doesNotMatch(script, /\|\|\s*true/u);
    assertOnlyPinnedPathWrite(script, version);
  }
});

test("extra bootstrap GITHUB_PATH writes fail the publication contract", async () => {
  const { jobs } = await canonicalRelease();
  const bootstrap = executable(releaseStep(jobs.release, npmBootstrap).run);
  const version = pinnedNpm(bootstrap);
  assertOnlyPinnedPathWrite(bootstrap, version);
  const extra = 'echo "/shared/older-npm" >> "$GITHUB_PATH"\n';
  assert.throws(() => assertOnlyPinnedPathWrite(bootstrap + extra, version), /GITHUB_PATH/);
  assert.throws(() => assertOnlyPinnedPathWrite(bootstrap + bootstrap, version), /GITHUB_PATH/);
});

test("nothing between the upgrade and the publish step can put an older npm back", async () => {
  const { jobs } = await canonicalRelease();
  const release = jobs.release.steps;
  const bootstrap = release.findIndex(step => step.name === npmBootstrap);
  const publish = release.findIndex(step => step.name === "Publish npm package");
  assert.ok(bootstrap >= 0 && bootstrap < publish);
  const between = release.slice(bootstrap + 1, publish + 1);
  const scripts = executable(between.map(step => step.run ?? "").join("\n"));
  assert.doesNotMatch(scripts, /GITHUB_PATH|corepack\s+(?:prepare|use)\s+npm@/u);
  assert.doesNotMatch(scripts, /npm\s+(?:install|i|add)\s+--prefix[^\n]+npm@/u);
  assert.ok(between.every(step => !step.uses?.startsWith("actions/setup-node@")));
  for (const job of Object.values(jobs)) {
    assert.doesNotMatch(executable(job.steps.map(step => step.run ?? "").join("\n")),
      /npm\s+(?:install|i|add)\s+(?:(?:-g|--global)\s+npm@|npm@\S+\s+(?:-g|--global))/u);
  }
});

test("no run script in the release job interpolates workflow context", async () => {
  const { jobs } = await canonicalRelease();
  for (const [name, job] of Object.entries(jobs)) {
    for (const step of job.steps) {
      assert.doesNotMatch(executable(step.run ?? ""), /\$\{\{/u, name + ": " + step.name);
    }
  }
});

test("no registry credential is configured, under any name or mechanism", async () => {
  const { jobs } = await canonicalRelease();
  const scripts = Object.values(jobs).flatMap(job => job.steps.map(step => step.run ?? "")).join("\n");
  const source = executable(scripts).replace(/-e\s+'\/[^']*\/d'/gu, "");
  const credential = "(?:_authToken|_auth|username|_password|certfile|keyfile)";
  assert.doesNotMatch(source, new RegExp(credential + "\\s*[=:]", "iu"));
  assert.doesNotMatch(source, /npm\s+(?:config\s+)?set\s+["']?\/\//iu);
  assert.doesNotMatch(source, /npm\s+login|always-auth/iu);
  assert.doesNotMatch(source, new RegExp(":" + credential + "\\s+\\S", "iu"));
  assert.doesNotMatch(source, new RegExp("npm\\s+(?:config\\s+)?set\\s+(?:--\\S+\\s+)*[\"']?(?:\\/\\/\\S*?[:/])?(?:" + credential + "|email)\\b", "iu"));
  for (const match of source.matchAll(/\bnpm_config_[a-z0-9_]+\b/giu)) {
    assert.equal(match[0].toUpperCase(), "NPM_CONFIG_USERCONFIG");
  }
  const publish = releaseStep(jobs.release, "Publish npm package");
  assert.doesNotMatch(JSON.stringify([publish.env, executable(publish.run)]), /secrets\s*(?:\.|\[)/u);
});

test("an empty or stale npm config credential is removed before publishing", async () => {
  const { jobs } = await canonicalRelease();
  const publish = executable(releaseStep(jobs.release, "Publish npm package").run);
  assert.match(publish, /npm --version/u);
  assert.match(publish, /sort -V/u);
  assert.match(publish, /NPM_CONFIG_USERCONFIG/u);
  assert.match(publish, /npm config get globalconfig/u);
  assert.match(publish, /sed -i/u);
  assert.match(publish, /-e '\/_authToken\/d'/u);
  for (const key of ["_auth", "username", "_password", "certfile", "keyfile"]) {
    assert.match(publish, new RegExp("-e '/:" + key + "\\[\\[:space:\\]\\]\\*=/d'", "u"));
    assert.match(publish, new RegExp("-e '/\\^\\[\\[:space:\\]\\]\\*" + key + "\\[\\[:space:\\]\\]\\*=/d'", "u"));
  }
  const upload = publish.indexOf("npm publish");
  assert.ok(upload > publish.indexOf("npm --version"));
  assert.ok(upload > publish.indexOf("_authToken"));
});

test("publication is proven possible before any remote release mutation", async () => {
  const { jobs } = await canonicalRelease();
  assert.match(releaseStep(jobs.prepare, "Check release ref").run, /refs\/heads\/main/u);
  assert.deepEqual(jobs.prepare.permissions, { contents: "read", "pull-requests": "read" });
  const name = "Verify npm will accept this workflow's OIDC identity";
  const targets = [
    [jobs.request, "Merge release metadata through protected PR", "needs.prepare.outputs.should_release == 'true' && inputs.npm-publish"],
    [jobs.release, "Publish npm package", "steps.continue.outputs.action == 'publish' && inputs.npm-publish"],
  ] as const;
  for (const [job, mutation, condition] of targets) {
    const preflight = releaseStep(job, name);
    assert.equal(preflight.if, condition);
    assert.equal(preflight["continue-on-error"], undefined);
    const step = executable(preflight.run);
    const before = job.steps.findIndex(candidate => candidate.name === name);
    const after = job.steps.findIndex(candidate => candidate.name === mutation);
    assert.ok(before >= 0 && before < after);
    assert.match(step, /oidc\/token\/exchange\/package\/\$\{pkg_path\}/u);
    assert.doesNotMatch(step, /exchange\/package\/\$\{pkg_name\}|encodeURIComponent/u);
    assert.match(step, /replace\('\/', '%2f'\)/u);
    const curls = (step.match(/curl\b/gu) ?? []).length;
    assert.equal(curls, 2);
    assert.equal((step.match(/--max-time\b/gu) ?? []).length, curls);
    assert.equal((step.match(/if ! \w+="\$\(curl\b/gu) ?? []).length, curls);
    assert.match(step, /status="000"/u);
    assert.match(step, /-ge 500/u);
    assert.match(step, /"429"/u);
    assert.doesNotMatch(step, /\$\{ACTIONS_ID_TOKEN_REQUEST_(?:URL|TOKEN)\}/u);
    assert.match(step, /\$\{ACTIONS_ID_TOKEN_REQUEST_URL:-\}/u);
    assert.match(step, /\$\{ACTIONS_ID_TOKEN_REQUEST_TOKEN:-\}/u);
    assert.doesNotMatch(step, /\[ "\$\{status\}" = "200" \]/u);
    assert.match(step, /-ge 200/u);
    assert.match(step, /-lt 300/u);
    assert.match(step, /set -euo pipefail/u);
    assert.match(step, /exit 1/u);
    assert.doesNotMatch(step, /\|\|\s*true/u);
    assert.equal((step.match(/\btrap\b/gu) ?? []).length, 1);
    assert.doesNotMatch(step, /echo\s+"?\$\{?id_token/u);
    assert.match(step, /response="\$\(mktemp\)"/u);
    assert.match(step, /trap\s+'rm -f "\$\{response\}"'\s+EXIT/u);
    assert.match(step, /-o "\$\{response\}"/u);
  }
});

test("changelog generation records breaking API changes before publish", () => {
  const scripts = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf-8")).scripts as Record<string, string>;
  const generators = ["changelog", "changelog:full", "changelog:check", "release:notes"];
  for (const name of generators) {
    assert.match(scripts[name], /^pm-changelog --/, name);
    assert.match(scripts[name], /--breaking-changes/, name);
  }
});

test("every changelog entry point retains published dependency updates", () => {
  const scripts = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).scripts as Record<string, string>;
  for (const name of ["changelog", "changelog:full", "changelog:check", "release:notes"]) {
    assert.match(scripts[name], /(?:^|\s)--dependency-updates(?=\s|$)/u, name);
  }
});

test("the release workflow generates the changelog only through the package scripts", async () => {
  const { jobs, on } = await canonicalRelease();
  for (const [input, script, variable] of [
    ["changelog-script", "changelog:full", "CHANGELOG_SCRIPT"],
    ["changelog-check-script", "changelog:check", "CHANGELOG_CHECK_SCRIPT"],
    ["notes-script", "release:notes", "NOTES_SCRIPT"],
  ]) {
    assert.equal(caller.jobs.release.with[input] ?? on.workflow_call.inputs[input].default, script);
    assert.equal(jobs.prepare.env[variable], "$" + "{{ inputs." + input + " }}");
  }
  const step = executable(releaseStep(jobs.prepare, "Generate changelog and release notes").run);
  assert.doesNotMatch(step, /\bpm-changelog\b/u);
  assert.match(step, /^\s*npm run "\$CHANGELOG_SCRIPT" -- --include-empty$/mu);
  assert.match(step, /^\s*npm run "\$CHANGELOG_CHECK_SCRIPT" -- --include-empty$/mu);
  assert.match(step, /^\s*npm run --silent "\$NOTES_SCRIPT" -- --include-empty > "\$RUNNER_TEMP\/RELEASE_NOTES\.md"$/mu);
});

test("every changelog generator agrees on empty releases", () => {
  // changelog:check renders empty releases. If changelog:full or release:notes
  // did not, the release would write a changelog its own check refuses, or
  // publish empty notes for a release whose changelog says "No changes.".
  const scripts = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf-8")).scripts as Record<string, string>;
  for (const name of ["changelog:full", "changelog:check", "release:notes"]) {
    assert.match(scripts[name], /--include-empty/, name);
  }
});

test("changelog:check keeps a prepared empty dated release stable after tagging and detects a real pending item", async (t) => {
  const { root, cleanup } = fixtureDirectory("ado-empty-release-");
  t.after(cleanup);
  const { scripts } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/token|secret|password|credential|api.?key|authorization/iu.test(key) ||
        /^(?:GIT_|NPM_MEDIA_SERVER$|npm_config_)/iu.test(key)) delete env[key];
  }
  if (env.NODE_OPTIONS) env.NODE_OPTIONS = relocateNodePreloads(env.NODE_OPTIONS, packageRoot);
  Object.assign(env, {
    NPM_CONFIG_USERCONFIG: devNull, npm_config_userconfig: devNull,
    PM_AUTHOR: "fixture-agent", GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1",
  });
  const options = { cwd: root, env, timeout: 60_000 };
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  /** Exercise the actual project scripts using the installed package binaries. */
  const changelog = (name: string) => runCommand(npm, ["run", name], { ...options, shell: process.platform === "win32" });
  /** Stamp only the package version while preserving the production scripts verbatim. */
  const version = (value: string) => writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "empty-release-fixture", version: value,
    scripts: { "changelog:full": scripts["changelog:full"], "changelog:check": scripts["changelog:check"] },
  }));
  /** Give both release commits the same explicit public test identity. */
  const commit = (message: string, date: string) => runCommand("git", [
    "-c", "user.name=unbrained", "-c", "user.email=1153461+unbraind@users.noreply.github.com", "commit", "-m", message,
  ], { ...options, env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });

  const pmRoot = join(root, ".agents/pm");
  const pm = new PmClient({ cwd: root, pmRoot, author: "fixture-agent" });
  await pm.init("fixture");
  symlinkSync(join(packageRoot, "node_modules"), join(root, "node_modules"), "junction");
  version("2026.11.04");
  await runCommand("git", ["init", "--initial-branch=main"], options);
  await runCommand("git", ["add", "package.json", ".agents/pm"], options);
  await commit("Previous release", "2026-11-04T12:00:00Z");
  await runCommand("git", ["tag", "v2026.11.04"], options);

  version("2026.11.05");
  await changelog("changelog:full");
  const file = join(root, "CHANGELOG.md");
  const prepared = readFileSync(file, "utf8");
  assert.match(prepared, /^## 2026\.11\.5 - 2026-11-05\n\nNo changes\.$/mu);
  assert.doesNotMatch(prepared, /^## Unreleased\b/mu);
  await changelog("changelog:check");
  await runCommand("git", ["add", "package.json", "CHANGELOG.md"], options);
  await commit("Prepared empty release", "2026-11-05T12:00:00Z");
  await runCommand("git", ["tag", "v2026.11.05"], options);
  await changelog("changelog:check");
  assert.equal(readFileSync(file, "utf8"), prepared);

  const { item } = await pm.create({ title: "A new pending delivery", type: "Task" });
  await pm.close(item.id, "Delivery verified");
  await assert.rejects(changelog("changelog:check"), { code: 1 });
  assert.equal(readFileSync(file, "utf8"), prepared, "check must not write the generated diff");
  await changelog("changelog:full");
  const pending = readFileSync(file, "utf8");
  assert.match(pending, /^## Unreleased\n(?:(?!^## ).*\n)*?^- A new pending delivery /mu);
  assert.match(pending, /^## 2026\.11\.5 - 2026-11-05\n\nNo changes\.$/mu);
  await changelog("changelog:check");
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
      ["-c", "user.name=unbrained", "-c", "user.email=1153461+unbraind@users.noreply.github.com", "commit", "-m", "Fixture release"],
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
    ["test/release-workflow.test.ts", "changelog:full keeps an omitted"],
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
    const targetEntry = file === "test/release-workflow.test.ts" ? /(?:[/\\]pm-changelog|[/\\]pm-changelog[/\\].*cli\.js)$/u
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
