import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { devNull, tmpdir } from "node:os";
import test from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { fixtureDirectory, packageRoot } from "./helpers/package-runtime.ts";
import { assertTargetPreloaded, fixtureProcessTimeoutMs, relocateNodePreloads, runCommand } from "./helpers/process-fixture.ts";

/** The release workflow source, read once and asserted against as text. */
const workflow = readFileSync(
  resolve(import.meta.dirname, "../.github/workflows/release.yml"),
  "utf-8"
);

/**
 * Locate a named workflow step so tests can assert on ordering between steps.
 *
 * Offsets are taken against the raw source rather than a comment-stripped copy:
 * removing text shifts every index after it, which would silently corrupt the
 * ordering comparisons these offsets exist to support.
 *
 * @param name - The exact `- name:` value of the step.
 * @returns The character offset of that step within the workflow source.
 */
function stepIndex(name: string): number {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `^[ \\t]*-[ \\t]+name:[ \\t]+${escapedName}[ \\t]*(?:#[^\\r\\n]*)?$`,
    "m"
  ).exec(workflow);
  assert.ok(match, `release workflow should contain the exact ${name} step`);
  return match.index;
}

test("npm publication authenticates by OIDC, with no stored token anywhere in the workflow", () => {
  // A stored npm token is what silently broke the whole fleet: it was rejected
  // from 2026-08-17 onward, every release job failed at the publish step with a
  // registry E404 on PUT, and main kept bumping the version regardless. Trusted
  // publishing removes the credential that can expire, so this test fails closed
  // if a token is ever reintroduced.
  const withoutComments = workflow.replace(/^[ \t]*#[^\r\n]*$/gm, "");

  assert.doesNotMatch(withoutComments, /NODE_AUTH_TOKEN/);
  assert.doesNotMatch(withoutComments, /NPM_TOKEN/);
  assert.doesNotMatch(withoutComments, /secrets\.NPM/);
});


/** Strip whole-line comments so a commented-out directive can never satisfy an
 * assertion that the directive is present. Applied to a slice, never used to
 * compute offsets — removing text shifts every index after it. */
function executable(source: string): string {
  return source.replace(/^[ \t]*#[^\r\n]*$/gm, "");
}

/**
 * Strip comments and the credential-scrub step's own deletion expressions.
 *
 * The scrub names every credential it removes, so a naive search for those names
 * matches the very code that deletes them. Removing `sed` deletion expressions
 * leaves only places a credential could actually be *configured*.
 *
 * @param source - Workflow source to filter.
 * @returns Source with comments and scrub deletion expressions removed.
 */
function withoutCredentialScrub(source: string): string {
  return executable(source)
    // Only the deletion fragments, never a whole line: a line such as
    // `sed -i'' -e '/_authToken/d' "$f"; printf '…_authToken=%s' "$S" >> "$f"`
    // deletes a credential and then restores one, and dropping the line would
    // hide the restore along with the deletion.
    .replace(/-e\s+'\/[^']*\/d'/g, "")
    .replace(/\bsed\s+-i(?:''|"")?/g, "");
}

/**
 * Extract the source of one workflow step, from its `- name:` line to the next.
 *
 * @param name - The exact `- name:` value of the step.
 * @returns That step's source alone, excluding neighbouring steps.
 */
function stepSource(name: string): string {
  const start = stepIndex(name);
  // Derive the boundary from the indentation of the step actually matched.
  // A fixed `^ {6}- name:` disagrees with stepIndex, which accepts any
  // indentation: if the workflow were reindented, the search would return -1,
  // stepSource would return the whole rest of the file, and every scoped
  // assertion would silently widen instead of failing.
  // stepIndex returns the offset of the line start, so the step's indentation is
  // the run of spaces at that offset.
  const indent = /^[ \t]*/.exec(workflow.slice(start))?.[0].length ?? 0;
  const rest = workflow.slice(start + 1);
  const next = rest.search(new RegExp(`^ {${indent}}- name:`, "m"));
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

/**
 * Resolve the permissions block that actually applies to the `release` job.
 *
 * A job-level `permissions:` block REPLACES the workflow-level one for that job
 * rather than merging with it, so reading whichever is nearest is the only
 * answer that matches GitHub's semantics.
 *
 * @returns The effective permissions source for the release job.
 */
function effectiveReleasePermissions(): string {
  const jobsAt = workflow.indexOf("jobs:\n  release:");
  assert.ok(jobsAt >= 0, "release workflow should declare a jobs.release entry");
  const afterKey = jobsAt + "jobs:\n  release:".length;
  const rest = workflow.slice(afterKey);
  const nextJob = rest.search(/^ {2}[A-Za-z][\w-]*:/m);
  const job = executable(nextJob === -1 ? rest : rest.slice(0, nextJob));

  // `permissions: { id-token: write }` - a flow mapping is still an override.
  const inline = /^ {4}permissions:[ \t]*(\{[^}]*\})[ \t]*$/m.exec(job);
  if (inline) return inline[1];

  // `permissions: read-all` and friends are overrides that grant no id-token.
  const scalar = /^ {4}permissions:[ \t]*([A-Za-z][\w-]*)[ \t]*$/m.exec(job);
  if (scalar) return scalar[1];

  const jobBlock = /^ {4}permissions:\n((?: {6}\S[^\n]*\n)+)/m.exec(job);
  if (jobBlock) return jobBlock[1];

  const topBlock = /^permissions:\n((?: {2}\S[^\n]*\n)+)/m.exec(
    executable(workflow.slice(0, jobsAt))
  );
  assert.ok(topBlock, "release workflow should declare permissions the release job inherits");
  return topBlock[1];
}

test("the release job effectively holds id-token: write, and no comment can stand in for it", () => {
  // Matching /id-token: write/ against the whole file is satisfied by a comment
  // reading "# id-token: write", and by a permission on some other job. Neither
  // grants this job anything, and OIDC publication fails closed without it.
  assert.match(effectiveReleasePermissions(), /(?:^|[{,\s])id-token:\s*write\s*(?:#[^\n]*)?$/m);
});

test("the npm upgrade cannot be skipped and fails closed on the version it actually gets", () => {
  // Asserting that the install command appears is not enough: the step can be
  // disabled with `if: ${{ false }}` or its failure swallowed with `|| true`,
  // and npm 10 stays active while the assertion still passes. The workflow
  // checks the EFFECTIVE version and exits non-zero, and that is what is
  // asserted here.
  const step = executable(stepSource("Use an npm that supports trusted publishing"));

  // Pinned exactly, not a caret range: a privileged publish job that resolves a
  // different npm on every run is not reproducible, and an unreviewed 11.x could
  // change publishing behaviour between two identical release commits.
  assert.match(step, /npm install -g npm@11\.19\.0(?!\S)/);
  assert.doesNotMatch(step, /npm install -g npm@[\^~]/);
  assert.doesNotMatch(step, /^ *if:/m);
  assert.match(step, /npm --version/);
  assert.match(step, /sort -V/);
  assert.match(step, /exit 1/);
  assert.doesNotMatch(step, /\|\|\s*true/);
  assert.match(step, /set -euo pipefail/);
});

test("nothing between the upgrade and the publish step can put an older npm back", () => {
  // Keeping the 11.x upgrade and then installing npm 10 later leaves trusted
  // publishing broken while every check above still passes.
  const upgrade = stepIndex("Use an npm that supports trusted publishing");
  const publish = stepIndex("Publish npm package");
  assert.ok(upgrade < publish, "npm must be upgraded before the publish step runs");

  // Through the END of the publish step, not merely up to its start: the
  // runtime version gate is the publish step's first command, so an install
  // placed after it and before `npm publish` would satisfy every check while
  // still publishing with a downgraded npm.
  const publishEnd = publish + stepSource("Publish npm package").length;
  const between = executable(workflow.slice(upgrade, publishEnd));
  const installs = [
    ...between.matchAll(/npm\s+(?:install|i|add)\s+(?:-g|--global)\s+npm@\S+/g),
    ...between.matchAll(/npm\s+(?:-g|--global)\s+(?:install|i|add)\s+npm@\S+/g),
  ];
  assert.equal(
    installs.length,
    1,
    `exactly one global npm install may appear before publication completes, found ${installs.length}`
  );
  assert.doesNotMatch(between, /corepack\s+(?:prepare|use)\s+npm@/);
  assert.doesNotMatch(between, /uses:\s*actions\/setup-node/);
  // Prepending a directory to GITHUB_PATH changes which npm later steps resolve
  // without installing anything, so it defeats an install-time check entirely.
  // The publish step re-verifies at runtime, but rejecting the write statically
  // means the run fails at review time rather than at publication time.
  assert.doesNotMatch(between, /GITHUB_PATH/);
});

test("no run script in the release job interpolates workflow context", () => {
  // Every step here executes with `id-token: write`. Expanding `${{ … }}` into a
  // shell script splices attacker-influenceable text - `github.event.repository.name`
  // is repository metadata - into a privileged command line. Values reach the
  // shell through `env:` instead, where the runner quotes them.
  // Only `run:` script bodies. An `env:` entry is exactly where interpolation
  // belongs - the runner passes the value as an environment variable rather
  // than splicing it into a command line - so flagging those would be noise.
  const jobs = workflow.indexOf("jobs:\n  release:");
  const offenders: string[] = [];
  let inRunBlock = false;
  for (const line of executable(workflow.slice(jobs)).split("\n")) {
    if (/^ {8}run: \|/.test(line)) {
      inRunBlock = true;
      continue;
    }
    // A `run:` on one line is a script too, just not a block scalar.
    if (/^ {8}run: /.test(line)) {
      inRunBlock = false;
      if (line.includes("${{")) offenders.push(line.trim());
      continue;
    }
    if (/^ {0,8}\S/.test(line)) inRunBlock = false;
    if (inRunBlock && line.includes("${{")) offenders.push(line.trim());
  }
  assert.deepEqual(offenders, [], `run scripts must not interpolate workflow context:\n  ${offenders.join("\n  ")}`);
});

test("no registry credential is configured, under any name or mechanism", () => {
  // Rejecting three literal token names is not enough: the credential can come
  // back as `secrets.PUBLISH_TOKEN` piped into an .npmrc `_authToken` line, or
  // through `npm login`, none of which mention NODE_AUTH_TOKEN. What matters is
  // that the publish step reaches the registry with no stored credential at all.
  const source = withoutCredentialScrub(workflow);

  // npm accepts a registry credential under several names, and rejecting only
  // the token spelling leaves the others open: `_auth` is basic auth,
  // `username`/`_password` is the legacy pair, and `certfile`/`keyfile` is mTLS.
  // Any one of them restores a stored credential the OIDC migration removed.
  for (const key of ["_authToken", "_auth", "username", "_password", "certfile", "keyfile"]) {
    assert.doesNotMatch(
      source,
      new RegExp(`${key}\\s*[=:]`),
      `release workflow must not configure the npm credential '${key}'`
    );
  }

  assert.doesNotMatch(source, /npm\s+(?:config\s+)?set\s+["']?\/\//i);
  assert.doesNotMatch(source, /npm\s+login/i);
  assert.doesNotMatch(source, /always-auth/i);
  // `npm config set //registry.npmjs.org/:_authToken value` separates key and
  // value with a space rather than `=`, which the key-plus-`=` checks miss.
  assert.doesNotMatch(source, /:(?:_authToken|_auth|username|_password|certfile|keyfile)\s+\S/i);

  // A GLOBAL credential needs no registry scope and no `=`:
  // `npm config set _auth <value>` configures legacy authentication that npm
  // honours, while every scoped and delimited check above passes.
  // `(?:--\S+\s+)*` matters: `npm config set --global _auth <value>` and
  // `--location=global` both put a flag between `set` and the key, and a
  // global credential is written OUTSIDE the userconfig the publish step
  // scrubs - so without this the guard passes and the scrub cannot reach it.
  assert.doesNotMatch(
    source,
    /npm\s+(?:config\s+)?set\s+(?:--\S+\s+)*["']?(?:\/\/\S*?[:/])?(?:_authToken|_auth|username|_password|certfile|keyfile|email)\b/i
  );

  // The same credentials can arrive as environment overrides rather than as
  // .npmrc lines. NPM_CONFIG_USERCONFIG is the one legitimate member of that
  // family here - it is how the publish step finds the file it strips.
  for (const [, name] of source.matchAll(/\b(npm_config_[a-z0-9_]+|NPM_CONFIG_[A-Z0-9_]+)\b/gi)) {
    assert.equal(
      name.toUpperCase(),
      "NPM_CONFIG_USERCONFIG",
      `release workflow must not set ${name}, which can carry a registry credential`
    );
  }

  // The publish step must carry no secret at all. Elsewhere in the job
  // `secrets.GITHUB_TOKEN` is legitimate (the gh CLI needs it), so this is
  // scoped rather than global.
  const publish = executable(stepSource("Publish npm package"));
  assert.doesNotMatch(publish, /secrets\s*(?:\.|\[)/);
});

test("the empty credential that setup-node generates is removed before publishing", () => {
  // `registry-url` makes setup-node write
  // `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` into the npm
  // userconfig. With no token in the environment that expands to an EMPTY
  // credential, and npm treats a configured-but-empty token as legacy auth -
  // which blocks the OIDC exchange and fails with the very registry 404 this
  // migration removes. Deleting the token env is therefore NOT sufficient on
  // its own; the generated line has to go too.
  // executable(), not raw source: this step's own comments mention _authToken
  // and NODE_AUTH_TOKEN, so deleting the scrub while keeping the comment would
  // leave every assertion below green against comment text.
  const publish = executable(stepSource("Publish npm package"));

  // Checking npm at install time does not bind at publish time: a later step can
  // prepend a directory to GITHUB_PATH and change which npm resolves here.
  assert.match(publish, /npm --version/);
  assert.match(publish, /sort -V/);
  assert.ok(
    publish.indexOf("npm --version") < publish.indexOf("npm publish"),
    "the effective npm must be re-verified before publication, not only at install time"
  );

  assert.match(publish, /NPM_CONFIG_USERCONFIG/);
  // A credential written with --global or --location=global lands in npm's
  // global config, which the userconfig scrub never touches.
  assert.match(publish, /npm config get globalconfig/);
  assert.match(publish, /sed -i/);

  // Deleting only the token spelling leaves basic auth, the legacy pair and the
  // mTLS pair in place - each of which npm will use instead of the exchange.
  // Asserting `publish.includes("_auth")` is satisfied by the `_authToken`
  // expression alone, so the loop passed while the basic-auth scrub could be
  // deleted outright. Each key is asserted in the DELIMITED form the scrub
  // actually uses, which no other key's expression can satisfy.
  assert.match(publish, /-e '\/_authToken\/d'/);
  for (const key of ["_auth", "username", "_password", "certfile", "keyfile"]) {
    assert.match(
      publish,
      new RegExp(`-e '/:${key}\\[\\[:space:\\]\\]\\*=/d'`),
      `the credential scrub must remove the registry-scoped '${key}'`
    );
    // npm honours an unscoped credential too, so removing only the scoped form
    // leaves legacy authentication configured.
    assert.match(
      publish,
      new RegExp(`-e '/\\^\\[\\[:space:\\]\\]\\*${key}\\[\\[:space:\\]\\]\\*=/d'`),
      `the credential scrub must remove the global '${key}'`
    );
  }
  // The strip must happen before the publish command, not after it.
  assert.ok(
    publish.indexOf("_authToken") < publish.indexOf("npm publish"),
    "the generated credential must be removed before npm publish runs"
  );
});

test("publication is proven possible before anything is mutated", () => {
  // The failure this guards against is not "publish broke" - it is "publish
  // broke and nothing said so". Because the bump and the release commit land
  // before the publish step, ten days of rejected credentials still advanced
  // main to a new version every night and published nothing. A preflight that
  // asks the registry for a credential up front converts that into a run that
  // fails immediately, having changed nothing.
  const refCheck = stepIndex("Check release ref");
  const preflight = stepIndex("Verify npm will accept this workflow's OIDC identity");
  const bump = stepIndex("Update release version");

  // The ref check must precede the preflight, not merely precede publication. A
  // workflow_dispatch from a feature branch would otherwise mint an id-token and
  // exchange it for a short-lived npm PUBLISH CREDENTIAL, and only then be
  // refused - obtaining a credential the run is forbidden to use. Refusing on
  // the ref is free; requesting a credential is not.
  assert.ok(
    refCheck < preflight,
    "the release ref must be checked before any credential is requested"
  );

  // The step check is not sufficient on its own. `npm ci` runs the checked-out
  // package's `prepare` hook, and it runs before any step-level refusal - with
  // this job's `id-token: write` held. A workflow_dispatch from a feature ref
  // would execute repository-controlled code with release privileges. The job
  // itself has to be gated.
  const jobHeader = workflow.slice(workflow.indexOf("jobs:\n  release:"), stepIndex("Checkout"));
  const jobIf = /^ {4}if: (.+)$/m.exec(executable(jobHeader))?.[1] ?? "";
  assert.match(
    jobIf,
    /github\.ref == 'refs\/heads\/main'/,
    "jobs.release must be gated by ref, not only by a step"
  );
  // Additional conditions may be ANDed onto the ref check - this repository
  // also requires PM_RELEASE_APPROVED, because a new package must not treat a
  // merge as implicit approval to publish to npm. A conjunction can only make
  // the gate stricter. A disjunction would let the ref check be bypassed by
  // satisfying the other side, so it is refused outright.
  assert.doesNotMatch(
    jobIf,
    /\|\|/,
    "jobs.release must not weaken the ref gate with a disjunction"
  );
  assert.match(executable(stepSource("Check release ref")), /refs\/heads\/main/);
  const commit = stepIndex("Commit release files");
  const publish = stepIndex("Publish npm package");

  assert.ok(preflight < bump, "the OIDC check must run before the version is bumped");
  assert.ok(preflight < commit, "the OIDC check must run before the release commit");
  assert.ok(preflight < publish, "the OIDC check must run before publication");

  const step = executable(stepSource("Verify npm will accept this workflow's OIDC identity"));

  // It has to actually reach the registry: asserting only that an id-token was
  // minted would pass while npm still refuses the identity at publish time.
  assert.match(step, /oidc\/token\/exchange\/package\//);

  // A scoped name is not path-safe: @unbrained/pm-web must reach the registry as
  // %40unbrained%2Fpm-web, and sending it raw addresses a different path. The URL
  // must therefore be built from the ENCODED name, not from package.json's value.
  // npm's escapedName preserves the leading `@` and encodes only the separator,
  // so @unbrained/pm-web must address @unbrained%2fpm-web. encodeURIComponent
  // would percent-encode the `@` too and address a path npm does not know.
  assert.match(step, /replace\('\/', '%2f'\)/);
  assert.doesNotMatch(step, /encodeURIComponent/);

  // An unbounded curl in a release gate turns a hung registry into a hung job
  // rather than a failed one, and the job holds an id-token while it hangs.
  assert.equal(
    (step.match(/curl\b/g) ?? []).length,
    (step.match(/--max-time\b/g) ?? []).length,
    "every curl in the preflight must be bounded with --max-time"
  );

  // A registry outage is not an identity refusal, and must not send a maintainer
  // to reconfigure a trusted publisher that is already correct.
  assert.match(step, /-ge 500/);
  // Rate limiting says nothing about whether a trusted publisher is bound.
  assert.match(step, /"429"/);

  // Under `set -u` a bare ${ACTIONS_ID_TOKEN_*} aborts the step with "unbound
  // variable" before the diagnosis can print, so the operator is told nothing.
  // The whole purpose of this step is a legible failure.
  assert.doesNotMatch(step, /\$\{ACTIONS_ID_TOKEN_REQUEST_(?:URL|TOKEN)\}/);
  assert.match(step, /\$\{ACTIONS_ID_TOKEN_REQUEST_URL:-\}/);
  assert.match(step, /\$\{ACTIONS_ID_TOKEN_REQUEST_TOKEN:-\}/);

  // Under `set -e` an uncaptured non-zero curl aborts before the 000 branch can
  // classify it, making every message below unreachable on exactly the failure
  // they exist to describe. Each curl must run inside an `if !` capture.
  const curls = (step.match(/curl\b/g) ?? []).length;
  const captured = (step.match(/if ! \w+="\$\(curl\b/g) ?? []).length;
  assert.equal(
    captured,
    curls,
    `every curl must have its exit status captured for classification (${captured}/${curls})`
  );
  assert.match(step, /status="000"/);
  assert.match(step, /exchange\/package\/\$\{pkg_path\}/);
  assert.doesNotMatch(step, /exchange\/package\/\$\{pkg_name\}/);

  // npm answers 201 on a successful exchange. Accepting only 200 fails a release
  // whose trusted publisher is correctly configured - a preflight that blocks
  // correct releases is worse than the outage it exists to prevent.
  assert.doesNotMatch(step, /\[ "\$\{status\}" = "200" \]/);
  assert.match(step, /-ge 200/);
  assert.match(step, /-lt 300/);
  assert.match(step, /set -euo pipefail/);
  assert.match(step, /exit 1/);
  assert.doesNotMatch(step, /\|\|\s*true/);

  // Fails closed: no `continue-on-error`, which would restore the silent drift
  // while leaving every assertion above satisfied.
  assert.doesNotMatch(step, /continue-on-error/);

  // The step legitimately carries an `if:`, so "has no condition" is the wrong
  // assertion - but that is exactly the hole `if: ${{ false }}` walks through,
  // leaving the step present, ordered correctly, and never executed while the
  // bump, commit and publish steps still run. Pin the EXACT condition, and pin
  // it to the same one the mutating steps use.
  const preflightCondition = /^ *if: steps\.decide\.outputs\.should_release == 'true'$/m;
  assert.match(step, preflightCondition);
  assert.equal(
    (step.match(/^ *if:/gm) ?? []).length,
    1,
    "the preflight must carry exactly one condition, so none can shadow the release condition"
  );
  assert.match(executable(stepSource("Update release version")), preflightCondition);

  // A second `trap ... EXIT` REPLACES the first, so appending one is enough to
  // keep the credential file on disk while every assertion above still passes.
  assert.equal(
    (step.match(/\btrap\b/g) ?? []).length,
    1,
    "exactly one EXIT trap may be installed, or a later one silently replaces the cleanup"
  );

  // The exchange response carries a publish credential. Capturing the status
  // separately from the body is what keeps it out of the log.
  assert.doesNotMatch(step, /echo\s+"?\$\{?id_token/);

  // The 200 response body IS a short-lived publish credential. Every later step
  // in this job runs as the same runner user, so leaving it on disk - and at a
  // predictable path - hands that credential to build, changelog and
  // release-check code that has no business holding it.
  assert.match(step, /response="\$\(mktemp\)"/);
  assert.match(step, /trap\s+'rm -f "\$\{response\}"'\s+EXIT/);
  assert.doesNotMatch(step, /-o\s+\/tmp\/[^\s"]+/);
  assert.match(step, /-o "\$\{response\}"/);
});

test("changelog generation records breaking API changes before publish", () => {
  const scripts = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf-8")).scripts as Record<string, string>;
  const generators = ["changelog", "changelog:full", "changelog:check", "release:notes"];
  for (const name of generators) {
    assert.match(scripts[name], /^pm-changelog --/, name);
    assert.match(scripts[name], /--breaking-changes/, name);
  }
});

test("the release workflow generates the changelog only through the package scripts", () => {
  // A second copy of the generator flags in the workflow drifted from the
  // scripts once (#71 added --include-empty to the scripts only), and
  // changelog:check then refused the changelog the workflow had just written.
  assert.doesNotMatch(workflow, /^\s*[^#\s].*\bpm-changelog\b/m, "the workflow must not invoke pm-changelog directly");
  const step = workflow.slice(workflow.indexOf("- name: Generate changelog and release notes"), workflow.indexOf("- name: Run release checks"));
  assert.match(step, /^\s+npm run changelog:full$/m);
  assert.match(step, /^\s+npm run changelog:check$/m);
  assert.match(step, /^\s+npm run --silent release:notes > RELEASE_NOTES\.md$/m);
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
