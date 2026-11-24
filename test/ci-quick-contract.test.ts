/** Hosted validation runs each suite once; deep and publication gates retain all coverage dimensions. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { caller } from "./helpers/release-caller.ts";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };

/** Expand package script calls so adding coverage through an alias cannot evade the hosted contract. */
function commands(name: string, ancestors: readonly string[] = [], scripts = manifest.scripts): string[] {
  assert.ok(!ancestors.includes(name), `recursive script: ${name}`);
  assert.equal(typeof scripts[name], "string", `missing script: ${name}`);
  return scripts[name].split(" && ").flatMap((command) => {
    const nested = /^npm run ([\w:-]+)$/.exec(command)?.[1] ?? (command === "npm test" ? "test" : undefined);
    if (nested) return commands(nested, [...ancestors, name], scripts);
    assert.ok(command === "npm pack --dry-run" || !/^npm(?:\s|$)/.test(command), `unrecognised npm command: ${command}`);
    return [command];
  });
}

test("hosted Node 26 runs the package test suite once without either coverage pass", () => {
  const quick = commands("ci:quick");
  assert.deepEqual(quick.filter((command) => command.includes("node --test")), [
    "node --test --test-concurrency=2 test/*.test.ts",
    "node --test --test-concurrency=2 test/hosted/release-workflow-source.test.ts",
  ]);
  assert.ok(quick.every((command) => !/coverage-gate|experimental-test-coverage/.test(command)));
  for (const name of ["typecheck", "docstring", "audit:prod", "pack:dry-run", "changelog:check", "verify:release-publish-attestation", "verify:release-changelog-date", "test:native-precondition"]) {
    assert.ok(manifest.scripts["ci:quick"].includes(`npm run ${name}`), name);
  }
  const ci = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  assert.equal(ci.jobs.test["timeout-minutes"], 30);
  assert.equal(ci.jobs.test.env.PM_TEST_DEPTH, "quick");
  const steps = ci.jobs.test.steps as { name?: string; if?: string; run?: string }[];
  const validation = steps.filter((step) => step.run?.includes("npm run ci:quick"));
  assert.equal(validation.length, 1);
  assert.match(validation[0].if!, /matrix.node-version == 26/);
  const floor = steps.find(step => step.name === "Engines floor tests");
  assert.match(floor?.if ?? "", /matrix.node-version == 22/u);
  assert.deepEqual(floor?.run?.trim().split("\n"), ["npm test", "npm run verify:release-publish-attestation"]);
  assert.ok(steps.every((step) => !step.run?.includes("npm run release:check")));
});

test("CI Deep uses full model depth and Daily Release runs quick-depth npm and Bun coverage", () => {
  assert.ok(commands("release:check").some((command) => command.includes("scripts/coverage-gate.ts")));
  assert.equal(manifest.scripts.prepublishOnly, "npm run release:check");
  const deep = parse(readFileSync(new URL("../.github/workflows/ci-deep.yml", import.meta.url), "utf8"));
  assert.equal(deep.jobs.deep.env.PM_TEST_DEPTH, "full");
  assert.ok(deep.jobs.deep.steps.some((step: { run?: string }) => step.run?.includes("npm run release:check")));
  assert.equal(caller.jobs.release.with["verify-script"], "release:check:quick");
  assert.equal(manifest.scripts["release:check:quick"], "PM_TEST_DEPTH=quick npm run release:check");
});

test("release attestation explicitly runs the live workflow-source contracts", () => {
  assert.deepEqual(commands("verify:release-publish-attestation"), [
    "node --test --test-concurrency=2 test/hosted/release-workflow-source.test.ts",
  ]);
  assert.match(manifest.scripts.test, /(?:^|\s)test\/\*\.test\.ts$/u);
});

test("unrecognised npm flags cannot hide a coverage alias from the quick contract", () => {
  const scripts = { quick: "npm run --silent coverage", coverage: "node scripts/coverage-gate.ts" };
  assert.throws(() => commands("quick", [], scripts), /unrecognised npm command: npm run --silent coverage/);
  assert.deepEqual(commands("quick", [], { ...scripts, quick: "npm run coverage" }), ["node scripts/coverage-gate.ts"]);
});
