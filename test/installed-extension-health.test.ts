import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { testTime } from "./support/time.ts";

const repo = resolve(import.meta.dirname, "..");
const cli = join(repo, "node_modules/@unbrained/pm-cli/dist/cli.js");

test("the packed project extension passes strict health without git", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ado-extension-health-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(home);
  const fixtureEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    NPM_CONFIG_USERCONFIG: devNull,
    npm_config_cache: join(root, "npm-cache"),
    PM_AUTHOR: "fixture-agent",
    PM_NO_UPDATE_CHECK: "1",
    GIT_CEILING_DIRECTORIES: root,
  };
  const pack = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", root, "--json"], {
    cwd: repo, env: fixtureEnv, encoding: "utf8", timeout: testTime(30_000),
  });
  assert.ifError(pack.error);
  assert.equal(pack.status, 0, pack.stderr);
  const [{ filename }] = JSON.parse(pack.stdout) as [{ filename: string }];
  const archive = join(root, filename);

  for (const [name, runtime] of [["Node", process.execPath], ["Bun", "bun"]]) {
    await t.test(name, () => {
      const tracker = join(root, name);
      mkdirSync(tracker);
      const trackerEnv = { ...fixtureEnv, PM_PATH: join(tracker, ".agents/pm"), PM_GLOBAL_PATH: join(tracker, "global") };
      /** Run the same pinned host with either runtime and preserve strict health's output on failure. */
      function pm(...args: string[]) {
        const result = spawnSync(runtime, [cli, ...args], {
          cwd: tracker, env: trackerEnv, encoding: "utf8", timeout: testTime(30_000),
        });
        assert.ifError(result.error);
        return result;
      }

      const init = pm("init", "--defaults", "--agent-guidance", "skip", "--prefix", "release", "--json");
      assert.equal(init.status, 0, init.stderr);
      const install = pm("package", "install", archive, "--project", "--json");
      assert.equal(install.status, 0, install.stderr);
      const receipt = JSON.parse(install.stdout) as {
        scope: string;
        details: { extension: { name: string }; activated: boolean; command_paths: string[] };
      };
      assert.equal(receipt.scope, "project");
      assert.equal(receipt.details.extension.name, "pm-ado");
      assert.equal(receipt.details.activated, true);
      assert.deepEqual(receipt.details.command_paths.sort(), [
        "ado artifact-plan", "ado contract", "ado export", "ado import", "ado move-preview",
        "ado refresh-plan", "ado resolve-apply", "ado resolve-plan", "ado sync", "ado validate",
      ]);
      assert.equal(existsSync(join(tracker, ".git")), false);

      const health = pm("health", "--strict-exit", "--full", "--json");
      const report = JSON.parse(health.stdout) as { ok: boolean; warnings: string[]; warnings_truncated: boolean };
      assert.equal(report.warnings_truncated, false);
      assert.deepEqual(report.warnings.filter((warning) => warning.includes("pm-ado")), []);
      assert.equal(health.status, 0, health.stdout + health.stderr);
      assert.equal(report.ok, true);
    });
  }
});
