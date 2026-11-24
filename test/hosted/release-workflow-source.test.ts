/** Compare public release authority with the live, immutable workflow during attestation. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";
import { caller, callerSource, releaseCallerPolicy } from "../helpers/release-caller.ts";
import { workflowGlobalNpmInstalls } from "../global-npm-guard.ts";

/** Named Actions steps as they execute after YAML block scalar decoding. */
interface ReleaseStep {
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  "continue-on-error"?: boolean;
}

/** Job-level conditions and permissions are part of the release contract. */
interface ReleaseJob {
  if: string;
  env: Record<string, string>;
  permissions: Record<string, string>;
  steps: ReleaseStep[];
}

/** Reusable workflow fields consumed by the local contract tests. */
interface CanonicalRelease {
  source: string;
  on: { workflow_call: { inputs: Record<string, { default: string | boolean }> } };
  jobs: Record<string, ReleaseJob>;
}

let pinnedRelease: Promise<CanonicalRelease> | undefined;

/** Audit the pinned source without keeping another copy of the release workflow. */
function canonicalRelease(): Promise<CanonicalRelease> {
  return pinnedRelease ??= (async () => {
    // The attestation audit verifies the tag against its canonical commit.
    // Check the structure before fetching public, credential-free raw source.
    const result = releaseCallerPolicy();
    assert.notEqual(result.status, "refused", result.errors.join("\n"));
    const sha = caller.jobs.release.uses.split("@")[1];
    const url = `https://raw.githubusercontent.com/unbraind/pm-ops/${sha}/.github/workflows/daily-release.yml`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
    assert.ok(response.ok, `Cannot read pinned Daily Release source (HTTP ${response.status})`);
    const source = await response.text();
    return { ...(parse(source) as Omit<CanonicalRelease, "source">), source };
  })();
}

/** Require one named shell step within the job that owns its authority. */
function releaseStep(job: ReleaseJob, name: string): ReleaseStep & { run: string } {
  const matches = job.steps.filter(step => step.name === name);
  assert.equal(matches.length, 1, name);
  const step = matches[0]!;
  assert.equal(typeof step.run, "string", name);
  return { ...step, run: step.run! };
}

/** Ignore whole-line comments in executable scripts. */
function executable(source: string): string {
  return source.replace(/^[ \t]*#[^\r\n]*$/gm, "");
}

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

test('every release preparation and publication job requires owner approval on main', async () => {
  assert.equal(caller.jobs.release.with['release-enabled'], "${{ github.ref == 'refs/heads/main' && vars.PM_RELEASE_APPROVED == 'true' }}");
  const { jobs } = await canonicalRelease();
  for (const name of ['reconcile', 'prepare', 'request', 'release', 'recover']) {
    const condition = jobs[name].if;
    assert.match(condition, /^inputs\.release-enabled && github\.ref == 'refs\/heads\/main'(?: && |$)/u, name);
    assert.doesNotMatch(condition, /\|\|/u, name);
  }
});

test("the canonical workflow keeps npm installations local to each job", async () => {
  assert.deepEqual(workflowGlobalNpmInstalls((await canonicalRelease()).source), []);
});

test('publishing uses a recent npm, OIDC permission and provenance without token environments', async () => {
  assert.deepEqual(caller.permissions, {});
  assert.deepEqual(caller.jobs.release.permissions, {
    contents: 'write', 'pull-requests': 'write', actions: 'write', checks: 'read', 'id-token': 'write', issues: 'write',
  });
  const { jobs } = await canonicalRelease();
  assert.equal(jobs.release.permissions['id-token'], 'write');
  const bootstrap = executable(releaseStep(jobs.release, 'Use an npm that supports trusted publishing').run);
  const version = bootstrap.match(/npm install --prefix "\$RUNNER_TEMP\/npm-(\d+)\.(\d+)\.(\d+)" npm@\1\.\2\.\3/u)?.slice(1).map(Number);
  assert.ok(version && (version[0] > 11 || version[0] === 11 && (version[1] > 5 || version[1] === 5 && version[2] >= 1)), 'publishing must install a trusted-publishing-capable npm into a job-local prefix');
  const publish = releaseStep(jobs.release, 'Publish npm package');
  const source = JSON.stringify([callerSource, jobs.release.env, publish.env]);
  assert.doesNotMatch(source, /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\s*(?:[:.]|\[)/u);
  const publishes = executable(publish.run).split('\n').filter(line => /^\s*npm publish\s/u.test(line));
  assert.ok(publishes.length > 0);
  for (const line of publishes) {
    assert.match(line, /(?:^|\s)--provenance(?:\s|$)/u);
    assert.match(line, /(?:^|\s)--access public(?:\s|$)/u);
  }
});

test('the job-local npm prefix is published to GITHUB_PATH and verified by exact version', async () => {
  const { jobs } = await canonicalRelease();
  for (const job of [jobs.prepare, jobs.release]) {
    const bootstrap = executable(releaseStep(job, 'Use an npm that supports trusted publishing').run);
    const install = bootstrap.match(/^\s*npm install --prefix "\$RUNNER_TEMP\/(npm-([\d.]+))" npm@\2(?=\s|$)/mu);
    assert.ok(install, 'the release workflow must install the pinned npm into a job-local prefix');
    const [, directory, version] = install;
    assert.ok(bootstrap.includes('echo "$RUNNER_TEMP/' + directory + '/node_modules/.bin" >> "$GITHUB_PATH"'));
    const verify = releaseStep(job, 'Verify job-local npm version');
    assert.equal(verify.run, 'test "$(npm --version)" = "' + version + '"');
  }
});

test("the canonical preparation and publication jobs bind the release gates", async () => {
  const { jobs } = await canonicalRelease();
  const checks = releaseStep(jobs.prepare, "Run release checks").run;
  assert.equal(jobs.prepare.env.VERIFY_SCRIPT, "${{ inputs.verify-script }}");
  assert.match(checks, /npm run "\$VERIFY_SCRIPT"/u);
  assert.match(checks, /verifyBunScript\(process.env.VERIFY_SCRIPT\)/u);
  assert.match(releaseStep(jobs.release, "Verify merged release").run, /git rev-parse 'HEAD\^\{tree\}'.+"\$VERIFIED_TREE"/u);
});
