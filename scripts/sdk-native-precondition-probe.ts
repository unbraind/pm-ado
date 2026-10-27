/** Blocking fixed-clock acceptance probe for the native SDK precondition missing in pm-cli#1576. */
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "ado-native-precondition-probe-"));
try {
  // A bounded source copy keeps both the reviewed checkout and its tracker untouched.
  for (const name of ["dist", "test", "manifest.json", "package.json", ...readdirSync(source).filter((name) => name.endsWith(".ts"))]) {
    cpSync(join(source, name), join(scratch, name), { recursive: true });
  }
  symlinkSync(join(source, "node_modules"), join(scratch, "node_modules"), "junction");
  appendFileSync(join(scratch, "test/sync.test.ts"), String.raw`

test("round-7 native history precondition acceptance", async (t) => {
  for (const mode of ["import", "export"] as const) {
    const sites = mode === "import" ? ["local-prepared", "update", "close-prepared", "close", "assignment", "agreement"] : ["local-prepared", "update", "agreement"];
    for (const site of sites) for (const edit of ["edit", "aba"] as const) await t.test(mode + ":" + site + ":" + edit, async (sub) => {
      const f = await fixture(sub, mode === "export" ? [] : [workItem()]);
      let item: runtimeSdk.ItemMetadata;
      if (mode === "import") {
        assert.equal((await f.command("import")).ok, true);
        item = await row(f.pm);
        f.items.get(1)!.fields["System.Title"] = "Planned remote title";
        f.items.get(1)!.fields["System.State"] = "Closed";
        f.items.get(1)!.rev++;
      } else item = (await f.pm.create({ title: "Planned export title", type: "Task" })).item;
      sub.mock.timers.enable({ apis: ["Date"], now: new Date(item.updated_at) });
      let foreign: runtimeSdk.ItemMetadata | undefined;
      let advanced = false;
      try {
        const result = await f.observed(mode, async (event) => {
          if (foreign === undefined && event.boundary === "local" && event.phase === "before" && event.operation === site) {
            const prior = (await f.pm.get(item.id)).item;
            const path = runtimeSdk.getHistoryPath(f.pmRoot, item.id);
            const before = (await runtimeSdk.readHistorySnapshot(path, item.id)).entries;
            await f.pm.update(item.id, { title: "Concurrent SDK title" });
            if (edit === "aba") await f.pm.update(item.id, { title: prior.title });
            const after = (await runtimeSdk.readHistorySnapshot(path, item.id)).entries;
            assert.equal(typeof before.at(-1)!.record_hash, "string");
            assert.equal(typeof after.at(-1)!.record_hash, "string");
            advanced = after.length > before.length && after.at(-1)!.record_hash !== before.at(-1)!.record_hash;
            assert.equal(advanced, true, "the native length and last record hash both advance");
            foreign = (await f.pm.get(item.id)).item;
            assert.equal(foreign.updated_at, item.updated_at, "the real SDK reuses the inspected millisecond");
            if (edit === "aba") assert.deepEqual(foreign, prior, "the ABA edit returns to identical item content");
          }
        });
        assert.ok(foreign, "the selected native write boundary was reached");
        const actual = (await f.pm.get(item.id)).item;
        const receipt = { site, mode, edit, history_advanced: advanced, ok: result.ok, code: result.code,
          title_preserved: actual.title === foreign.title,
          item_preserved: resolutionDigest(actual) === resolutionDigest(foreign) };
        sub.diagnostic(JSON.stringify(receipt));
        assert.equal(result.ok, false, "an advanced native history head requires a conflict");
        assert.equal(result.code, "ADO_CONFLICT");
        assert.deepEqual(actual, foreign, "no stale native mutation may follow the concurrent SDK edit");
      } finally { sub.mock.timers.reset(); }
    });
  }
});
`);
  const childEnv: NodeJS.ProcessEnv = { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir(), NPM_CONFIG_USERCONFIG: "/dev/null" };
  for (const key of Object.keys(childEnv)) if (/(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|CREDENTIAL)/iu.test(key)) delete childEnv[key];
  for (const key of ["NPM_MEDIA_SERVER", "ADO_ORG_URL", "ADO_PROJECT", "PM_PATH", "PM_ROOT", "PM_GLOBAL_PATH"]) delete childEnv[key];
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=2", "--test-name-pattern=round-7 native history precondition acceptance", "test/sync.test.ts"],
    { cwd: scratch, env: childEnv, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  // Publish only bounded fixture receipts/counts, never local paths from assertion stacks.
  for (const line of result.stdout.split("\n")) {
    const receipt = line.match(/ℹ (\{.*\}|(?:tests|pass|fail|cancelled|skipped|todo) \d+)$/u);
    if (receipt) process.stdout.write(receipt[0] + "\n");
  }
  if (result.status !== 0) process.stderr.write("Native monotonic-precondition acceptance is BLOCKED; see unbraind/pm-cli#1576.\n");
  process.exitCode = result.status ?? 1;
} finally { rmSync(scratch, { recursive: true, force: true }); }
