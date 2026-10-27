/** Packed non-git consumers exercise real package-manager launchers without changing global state. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { AdoWorkItem, ResolutionPlan } from "../index.ts";

const execute = promisify(execFile);
const repo = resolve(import.meta.dirname, "..");

/** Run an actual binary and retain useful output on a failing acceptance command. */
async function command(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  try { return (await execute(binary, args, { cwd, env, timeout: 180000, maxBuffer: 4 * 1024 * 1024 })).stdout; }
  catch (error) {
    const result = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`${binary.split("/").at(-1)} ${args[0]} failed: ${result.stdout}\n${result.stderr}`, { cause: result });
  }
}

/** Exercise packed code through every requested installer and executable shape, using only private temp prefixes. */
test("packed npm-global, bun-global, npx, bunx, local-bin and copied-extension commands work without git", { timeout: 900000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ado-packed-shapes-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false); });
  const home = join(root, "home"), artifacts = join(root, "artifacts"), safeBin = join(root, "no-git-bin");
  for (const path of [home, artifacts, safeBin]) mkdirSync(path);
  const bun = realpathSync((await execute("sh", ["-c", "command -v bun"])).stdout.trim());
  const npx = realpathSync((await execute("sh", ["-c", "command -v npx"])).stdout.trim());
  const npm = realpathSync((await execute("sh", ["-c", "command -v npm"])).stdout.trim());
  for (const [name, target] of [["node", process.execPath], ["bun", bun], ["bunx", bun], ["sh", "/bin/sh"]]) symlinkSync(target!, join(safeBin, name!));
  const bunHome = join(root, "bun-home"), bunGlobal = join(root, "bun-global"), bunBin = join(root, "bun-bin");
  mkdirSync(join(home, ".config"));
  writeFileSync(join(home, ".config/.bunfig.toml"), `[install]\nglobalDir = ${JSON.stringify(bunGlobal)}\nglobalBinDir = ${JSON.stringify(bunBin)}\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
    npm_config_cache: join(root, "npm-cache"), npm_config_prefix: join(root, "npm-prefix"), npm_config_ignore_scripts: "true", npm_config_update_notifier: "false", npm_config_audit: "false", npm_config_fund: "false",
    npm_config_userconfig: join(home, ".npmrc"), NPM_CONFIG_USERCONFIG: join(home, ".npmrc"),
    BUN_INSTALL: bunHome, BUN_INSTALL_GLOBAL_DIR: bunGlobal, BUN_INSTALL_BIN: bunBin, BUN_INSTALL_CACHE_DIR: join(root, "bun-cache"), PM_AUTHOR: "fixture-agent", PM_NO_UPDATE_CHECK: "1",
    GIT_CEILING_DIRECTORIES: tmpdir(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  // Never inherit a real Azure credential or private npm configuration.
  for (const key of ["ADO_ORG_URL", "ADO_TOKEN", "ADO_PROJECT", "ADO_STATUS_MAP", "ADO_EXPORT_STATE_MAP", "NODE_PATH", "NPM_TOKEN", "NODE_AUTH_TOKEN", "PM_PATH", "PM_ROOT", "PM_GLOBAL_PATH", "PM_GLOBAL_ROOT"]) delete env[key];
  await command(process.execPath, [npm, "pack", "--ignore-scripts", "--pack-destination", artifacts, repo], root, env);
  await command(process.execPath, [npm, "pack", "--ignore-scripts", "--pack-destination", artifacts, "@unbrained/pm-cli@2026.10.25"], root, env);
  const packageTar = join(artifacts, readdirSync(artifacts).find((file) => file.startsWith("pm-ado-"))!);
  const hostTar = join(artifacts, readdirSync(artifacts).find((file) => file.startsWith("unbrained-pm-cli-"))!);
  const unpacked = join(root, "unpacked"); mkdirSync(unpacked);
  await command("tar", ["-xzf", packageTar, "-C", unpacked], root, env);
  const packageRoot = join(unpacked, "package");
  assert.ok(existsSync(join(packageRoot, "dist/refresh.js")));
  const npmPrefix = join(root, "npm-global"), local = join(root, "local"); mkdirSync(local);
  await command(process.execPath, [npm, "install", "--global", "--prefix", npmPrefix, "--ignore-scripts", "--no-audit", hostTar], root, env);
  await command(bun, ["add", "--global", "--ignore-scripts", hostTar], root, env);
  await command(process.execPath, [npm, "install", "--prefix", local, "--ignore-scripts", "--no-audit", hostTar], root, env);
  // Prime npm exec's version-keyed cache once; all acceptance invocations below are offline.
  assert.equal((await command(process.execPath, [npx, "--yes", "--package", "@unbrained/pm-cli@2026.10.25", "pm", "--version"], root, env)).trim(), "2026.10.25");
  const npmPm = join(npmPrefix, "bin/pm"), bunPm = join(bunBin, "pm"), localPm = join(local, "node_modules/.bin/pm");
  assert.ok(lstatSync(npmPm).isSymbolicLink(), "npm global bin must be the actual symlink");
  assert.ok(existsSync(bunPm), "Bun global executable must be in its private configured prefix");
  let remote: AdoWorkItem;
  const extra = new Map<number, AdoWorkItem>();
  let queryIds = [1];
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { ids?: number[] };
    calls.push(req.url!); res.setHeader("content-type", "application/json");
    if (req.url!.includes("/wiql")) res.end(JSON.stringify({ workItems: queryIds.map((id) => ({ id })) }));
    else if (req.url!.includes("workitemsbatch")) res.end(JSON.stringify({ value: body.ids!.map((id) => id === 1 ? remote : extra.get(id)) }));
    else { res.statusCode = 500; res.end("{}"); }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const org = `http://127.0.0.1:${address.port}/example`;
  const runtime = { ...env, PATH: safeBin, ADO_ORG_URL: org, ADO_PROJECT: "Example", ADO_TOKEN: "synthetic-token" };
  const shapes = [
    { name: "npm-global-symlink", binary: npmPm, prefix: [] },
    { name: "bun-global", binary: bunPm, prefix: [] },
    { name: "npx", binary: process.execPath, prefix: [npx, "--offline", "--yes", "--package", "@unbrained/pm-cli@2026.10.25", "pm"] },
    { name: "bunx", binary: join(safeBin, "bunx"), prefix: ["--package", hostTar, "pm"] },
    { name: "project-local-bin", binary: localPm, prefix: [] },
    { name: "copied-tracker-extension", binary: npmPm, prefix: [] },
  ];
  /** Exercise a changed inverse endpoint through the real launcher in either installation scope. */
  async function assertEndpointPreserved(pm: (args: string[]) => Promise<string>) {
    for (const id of [2, 3]) extra.set(id, { id, rev: 1, relations: [], fields: { ...remote.fields, "System.Title": `Packed peer ${id}`, "System.State": "New" } });
    remote.fields["System.State"] = "New";
    remote.relations = [{ rel: "System.LinkTypes.Hierarchy-Forward", url: `${org}/_apis/wit/workItems/2` }]; remote.rev++;
    extra.get(2)!.relations = [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: `${org}/_apis/wit/workItems/1` }];
    queryIds = [1, 2, 3]; assert.equal((JSON.parse(await pm(["ado", "import"])) as { ok: boolean }).ok, true);
    const graph = (JSON.parse(await pm(["list", "--all", "--full"])) as { items: { id: string; ado_id: number }[] }).items;
    const child = graph.find((item) => item.ado_id === 2)!;
    await pm(["update", child.id, "--unset", "parent"]);
    const before = (JSON.parse(await pm(["get", child.id])) as { item: unknown }).item;
    remote.relations = []; remote.rev++;
    extra.get(2)!.relations = [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: `${org}/_apis/wit/workItems/3` }]; extra.get(2)!.rev++;
    extra.get(3)!.relations = [{ rel: "System.LinkTypes.Hierarchy-Forward", url: `${org}/_apis/wit/workItems/2` }]; extra.get(3)!.rev++;
    queryIds = [3];
    await assert.rejects(pm(["ado", "sync", "--limit", "1"]), /ADO_CONFLICT/u);
    assert.deepEqual((JSON.parse(await pm(["get", child.id])) as { item: unknown }).item, before, "the entire unselected endpoint survives");
  }
  for (const shape of shapes) {
    await t.test(shape.name, async () => {
      extra.clear(); queryIds = [1];
      const tracker = join(root, `tracker-${shape.name}`); mkdirSync(tracker);
      /** Invoke the real package-manager executable, never its resolved CLI target. */
      const pm = (args: string[]) => command(shape.binary, [...shape.prefix, "--pm-path", join(tracker, ".agents/pm"), ...args, "--json"], tracker, runtime);
      assert.equal((await command(shape.binary, [...shape.prefix, "--version"], tracker, runtime)).trim(), "2026.10.25");
      await pm(["init", "--prefix", "fixture"]);
      await pm(["install", packageRoot, "--project"]);
      if (shape.name === "copied-tracker-extension") {
        // All these links were created by this fixture's pm install; remove only its owned SDK links.
        const links = readdirSync(join(tracker, ".agents"), { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isSymbolicLink() && entry.name === "pm-cli" && entry.parentPath.endsWith("node_modules/@unbrained"));
        assert.ok(links.length > 0, "pm install must provide the documented host SDK link");
        for (const link of links) rmSync(join(link.parentPath, link.name));
      }
      assert.equal(existsSync(join(tracker, ".git")), false);
      const created = JSON.parse(await pm(["create", "Task", "Local seed", "--field", "ado_id=1", "--field", "ado_rev=1",
        "--field", `ado_org_url=${org}`, "--field", "ado_project=Example"])) as { id: string };
      remote = { id: 1, rev: 2, relations: [], fields: { "System.Title": "Packed remote", "System.Description": "Details", "System.State": "Closed",
        "System.WorkItemType": "Task", "Microsoft.VSTS.Common.Priority": 2, "System.Tags": "fixture", "System.AreaPath": "Example", "System.IterationPath": "Example" } };
      for (const mode of ["import", "export", "sync", "refresh-plan"]) {
        if (shape.name === "copied-tracker-extension" && mode !== "refresh-plan") {
          await assert.rejects(pm(["ado", mode]), /ADO_USAGE[\s\S]*host links its SDK/u);
          continue;
        }
        const result = JSON.parse(await pm(["ado", mode, ...(mode === "refresh-plan" ? ["--fields", "title,status,relations"] : [])])) as { ok: boolean; cost?: { pm_mutations: number } };
        assert.equal(result.ok, true, `${shape.name}: ${mode}`);
        if (result.cost) assert.equal(result.cost.pm_mutations, 0);
      }
      const rows = JSON.parse(await pm(["list", "--all", "--full"])) as { items: { id: string; status: string; ado_rev: number }[] };
      assert.equal(rows.items.length, 1); assert.equal(rows.items[0]!.status, shape.name === "copied-tracker-extension" ? "open" : "closed"); assert.equal(rows.items[0]!.ado_rev, shape.name === "copied-tracker-extension" ? 1 : 2);
      if (shape.name !== "copied-tracker-extension") {
        const plan = JSON.parse(await pm(["ado", "resolve-plan", "--item", created.id])) as { ok: boolean };
        assert.equal(plan.ok, true, "resolution's lazy module link must also survive this launcher");
        await pm(["update", created.id, "--field", `ado_sync_base=${JSON.stringify({ ado_base_partial: 1, relations: [] })}`]);
        remote.fields["System.Title"] = "Concurrent packed title"; remote.rev++;
        const partial = JSON.parse(await pm(["ado", "resolve-plan", "--item", created.id])) as { ok: boolean; plan: ResolutionPlan };
        assert.equal(partial.ok, true); assert.ok(partial.plan.fields.every((field) => field.base === null));
        assert.equal(partial.plan.fields.find((field) => field.field === "title")!.conflict, true);
        const toon = await command(shape.binary, [...shape.prefix, "--pm-path", join(tracker, ".agents/pm"), "ado", "resolve-plan", "--item", created.id, "--output-format", "toon"], tracker, runtime);
        assert.match(toon, /title,null,/u);
        partial.plan.choices = partial.plan.fields.filter((field) => field.local !== field.remote).map(({ field }) => ({ field, take: "remote" }));
        const artifact = join(tracker, "reviewed-partial.json"); writeFileSync(artifact, JSON.stringify(partial.plan));
        const before = (JSON.parse(await pm(["get", created.id])) as { item: unknown }).item;
        await assert.rejects(pm(["ado", "resolve-apply", "--artifact", artifact]), /configuration[\s\S]*SDK semantic preview/u);
        assert.deepEqual((JSON.parse(await pm(["get", created.id])) as { item: unknown }).item, before, "SDK storage guards precede preparation");
        await assertEndpointPreserved(pm);

      } else {
        await assert.rejects(pm(["ado", "resolve-plan", "--item", created.id]), /configuration[\s\S]*pm install/u);
        await assert.rejects(pm(["ado", "resolve-plan"]), /Supply --item/u);
        await assert.rejects(pm(["ado", "resolve-apply"]), /Supply exactly one/u);
      }
      t.diagnostic(`${shape.name}: ${shape.name === "copied-tracker-extension" ? "read-only refresh succeeds; guarded writes name the missing SDK link" : "4/4 commands and SDK state readback pass"}; lazy resolution checks pass; no git executable`);
    });
  }
  for (const shape of shapes.filter((shape) => shape.name !== "copied-tracker-extension")) {
    await t.test(`global-runtime ${shape.name}`, async () => {
      extra.clear(); queryIds = [1];
      remote = { id: 1, rev: 2, relations: [], fields: { "System.Title": "Packed global remote", "System.Description": "Details", "System.State": "Closed",
        "System.WorkItemType": "Task", "Microsoft.VSTS.Common.Priority": 2, "System.Tags": "fixture", "System.AreaPath": "Example", "System.IterationPath": "Example" } };
      const tracker = join(root, `global-tracker-${shape.name}`), globalHome = join(root, `global-home-${shape.name}`);
      mkdirSync(tracker); mkdirSync(globalHome); mkdirSync(join(globalHome, ".config"));
      const globals = { ...runtime, HOME: globalHome, XDG_CONFIG_HOME: join(globalHome, ".config") };
      await command(shape.binary, [...shape.prefix, "install", packageRoot, "--global", "--json"], tracker, globals);
      /** Keep the SDK-managed global module link outside this non-git tracker. */
      const pm = (args: string[]) => command(shape.binary, [...shape.prefix, "--pm-path", join(tracker, ".agents/pm"), ...args, "--json"], tracker, globals);
      await pm(["init", "--prefix", "fixture"]);
      assert.equal((JSON.parse(await pm(["ado", "import"])) as { ok: boolean }).ok, true);
      const created = (JSON.parse(await pm(["list", "--all", "--full"])) as { items: { id: string }[] }).items[0]!;
      await pm(["update", created.id, "--field", `ado_sync_base=${JSON.stringify({ ado_base_partial: 1, relations: [] })}`]);
      remote.fields["System.Title"] = "Reviewed packed title"; remote.rev++;
      const partial = JSON.parse(await pm(["ado", "resolve-plan", "--item", created.id])) as { ok: boolean; plan: ResolutionPlan };
      assert.equal(partial.ok, true); assert.ok(partial.plan.fields.every((field) => field.base === null));
      const toon = await command(shape.binary, [...shape.prefix, "--pm-path", join(tracker, ".agents/pm"), "ado", "resolve-plan", "--item", created.id, "--output-format", "toon"], tracker, globals);
      assert.match(toon, /title,null,/u);
      partial.plan.choices = partial.plan.fields.filter((field) => field.local !== field.remote).map(({ field }) => ({ field, take: "remote" }));
      const artifact = join(tracker, "reviewed-partial.json"); writeFileSync(artifact, JSON.stringify(partial.plan));
      assert.equal((JSON.parse(await pm(["ado", "resolve-apply", "--artifact", artifact])) as { ok: boolean }).ok, true);
      assert.equal((JSON.parse(await pm(["get", created.id])) as { item: { title: string } }).item.title, "Reviewed packed title");
      await assertEndpointPreserved(pm);
      assert.equal(existsSync(join(tracker, ".git")), false);
      t.diagnostic(`${shape.name}: global SDK runtime supports partial-base apply and preserves unselected endpoint edits`);
    });
  }
  assert.ok(calls.length >= 24);
});
