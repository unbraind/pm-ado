/** Fixed-clock pre-dispatch refusal acceptance; no rollback, with the remaining SDK window documented. */
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = resolve(import.meta.dirname, "..");
/** The native-precondition matrix: every write site per direction, each with a plain peer edit and an ABA edit. */
const IMPORT_SITES = ["local-prepared", "update", "close-prepared", "close", "assignment", "agreement"];
const EXPORT_SITES = ["local-prepared", "update", "agreement"];
const EDITS = ["edit", "aba"];
/** One top-level test plus one subtest per site and edit; a complete run must report exactly this many. */
const EXPECTED_TESTS = (IMPORT_SITES.length + EXPORT_SITES.length) * EDITS.length + 1;
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
    const sites = mode === "import" ? ${JSON.stringify(IMPORT_SITES)} : ${JSON.stringify(EXPORT_SITES)};
    for (const site of sites) for (const edit of ${JSON.stringify(EDITS)} as const) await t.test(mode + ":" + site + ":" + edit, async (sub) => {
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
  // A name pattern that matches nothing still exits 0 with one passing test, and a reduced matrix would also pass,
  // so the run counts only when the summary reports exactly the full matrix, all passing, nothing skipped.
  const count = (name: string) => Number(result.stdout.match(new RegExp(`ℹ ${name} (\\d+)$`, "mu"))?.[1] ?? Number.NaN);
  const complete = count("tests") === EXPECTED_TESTS && count("pass") === EXPECTED_TESTS
    && ["fail", "cancelled", "skipped", "todo"].every((name) => count(name) === 0);
  if (result.status !== 0) process.stderr.write("Native monotonic-precondition acceptance failed; see unbraind/pm-cli#1576.\n");
  else if (!complete) process.stderr.write(`Native monotonic-precondition acceptance was incomplete: expected ${EXPECTED_TESTS} passing tests and none failed, cancelled, skipped or todo.\n`);
  process.exitCode = result.status !== 0 ? result.status ?? 1 : complete ? 0 : 1;
} finally { rmSync(scratch, { recursive: true, force: true }); }
