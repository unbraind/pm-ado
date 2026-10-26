/** Published consumer and built declarations protect additive public API changes. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const repo = resolve(import.meta.dirname, "..");
const fixtures = join(repo, "test/fixtures/public-api");

/** Enumerate the complete declaration modules, preserving every published name and signature. */
function declarations(root: string, suffix = ".d.ts") {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/")).sort();
}

test("built exported API matches the deliberately maintained declaration snapshot", () => {
  const actual = declarations(join(repo, "dist"));
  const saved = declarations(join(fixtures, "current"), ".d.ts.txt").map((file) => file.slice(0, -4));
  assert.deepEqual(actual, saved, "API module removal/addition requires deliberate snapshot review");
  for (const file of actual) assert.equal(readFileSync(join(repo, "dist", file), "utf8"), readFileSync(join(fixtures, "current", `${file}.txt`), "utf8"), `${file}: exported declaration drift; review compatibility before updating the snapshot`);
});

test("unchanged published consumer compiles and runs against built code under Node and Bun", { timeout: 180000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ado-api-consumer-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false); });
  const provenance = JSON.parse(readFileSync(join(fixtures, "published-provenance.json"), "utf8")) as { version: string; consumer_sha256: string; declarations: Record<string, string> };
  assert.equal(provenance.version, "2026.10.26");
  const consumer = join(root, "consumer"); mkdirSync(consumer);
  const modules = join(consumer, "node_modules"); mkdirSync(join(modules, "@unbrained"), { recursive: true });
  symlinkSync(join(repo, "node_modules/@unbrained/pm-cli"), join(modules, "@unbrained/pm-cli"), "junction");
  symlinkSync(join(repo, "node_modules/@types"), join(modules, "@types"), "junction");
  const installed = join(modules, "pm-ado"); mkdirSync(installed);
  cpSync(join(repo, "dist"), join(installed, "dist"), { recursive: true });
  for (const file of ["package.json", "manifest.json"]) cpSync(join(repo, file), join(installed, file));
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ type: "module" }));
  assert.equal(createHash("sha256").update(readFileSync(join(fixtures, "consumer.mts"))).digest("hex"), provenance.consumer_sha256);
  cpSync(join(fixtures, "consumer.mts"), join(consumer, "consumer.mts"));
  const bun = (await run("sh", ["-c", "command -v bun"])).stdout.trim();
  const safeBin = join(root, "no-git-bin"); mkdirSync(safeBin);
  symlinkSync(process.execPath, join(safeBin, "node"));
  symlinkSync(bun, join(safeBin, "bun"));
  const consumerHome = join(root, "home"); mkdirSync(consumerHome);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: consumerHome, PATH: safeBin, XDG_CONFIG_HOME: join(consumerHome, ".config"), BUN_INSTALL: join(root, "bun-home"), BUN_INSTALL_CACHE_DIR: join(root, "bun-cache"), PM_AUTHOR: "fixture-agent", PM_NO_UPDATE_CHECK: "1", GIT_CEILING_DIRECTORIES: tmpdir() };
  for (const key of ["PM_PATH", "PM_ROOT", "PM_GLOBAL_PATH", "ADO_ORG_URL", "ADO_PROJECT", "ADO_TOKEN"]) delete env[key];
  for (const mode of ["built", "published"] as const) {
    if (mode === "published") for (const [name, digest] of Object.entries(provenance.declarations)) {
      const data = readFileSync(join(fixtures, "published", `${name.slice("dist/".length)}.txt`));
      assert.equal(createHash("sha256").update(data).digest("hex"), digest, `${name}: published baseline changed`);
      writeFileSync(join(installed, name), data);
    }
    else cpSync(join(repo, "dist"), join(installed, "dist"), { recursive: true });
    writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: true,
      rewriteRelativeImportExtensions: true, allowImportingTsExtensions: true, outDir: `out-${mode}`, types: ["node"] }, files: ["consumer.mts"] }));
    const compiled = await run(process.execPath, [join(repo, "node_modules/typescript/bin/tsc"), "-p", join(consumer, "tsconfig.json")], { cwd: consumer, env, timeout: 60000 });
    assert.equal(compiled.stderr, "");
    for (const runtime of [process.execPath, bun]) {
      const tracker = join(root, `${mode}-${runtime === bun ? "bun" : "node"}`); mkdirSync(tracker);
      const result = await run(runtime, [join(consumer, `out-${mode}/consumer.mjs`), tracker], { cwd: consumer, env, timeout: 60000 });
      assert.equal((JSON.parse(result.stdout) as { ok: boolean }).ok, true);
      assert.equal(existsSync(join(tracker, ".git")), false);
    }
  }
  t.diagnostic("same previous-API source: published and built declaration checks; Node + Bun runtime; five constructor forms, one-argument reads and loader anchors");
});
