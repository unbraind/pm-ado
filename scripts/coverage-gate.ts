/**
 * Coverage gate for the package test suite.
 *
 * Runs `node --test` with the runtime's built-in V8 coverage against the
 * TypeScript sources directly (Node executes `.ts` natively, so the reported
 * line numbers are the ones an author edits, not compiled output), enforces a
 * per-dimension threshold, and reconciles the reported file list against the
 * files actually on disk.
 *
 * That last step is the reason this script exists rather than a bare
 * `node --test --test-coverage-lines=...` invocation. Node only reports files
 * that were loaded during the run: a source module with no test at all is
 * omitted from the report entirely rather than reported at zero. The published
 * percentage is therefore computed over the tested subset, and a package can
 * satisfy a 100% threshold while an entire module goes unexercised. Comparing
 * the report against a directory walk turns that silent omission into a failure
 * naming the missing files, so the threshold cannot be passed by narrowing what
 * the suite touches.
 *
 * Configuration lives in `package.json` under `coverageGate` so the numbers the
 * gate enforces are visible in the same file that declares the scripts, and a
 * threshold change shows up in review as a deliberate diff.
 *
 * The gate logic lives in {@link runCoverageGate}, which accepts a root
 * directory and returns an exit code. When the file is executed directly (`node
 * scripts/coverage-gate.ts`) the module-level guard calls that function with the
 * script's own parent directory and forwards the result to `process.exit`.
 * Tests import the function and drive it against purpose-built fixture projects
 * so the gate is measured by the very coverage it enforces.
 *
 * @example
 * ```bash
 * node scripts/coverage-gate.ts
 * ```
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Minimum acceptable percentage for each coverage dimension Node reports.
 *
 * Statement coverage is not listed because V8 reports statements as lines; the
 * line figure is the statement figure for this runtime.
 */
interface CoverageThresholds {
  /** Minimum percentage of executable lines that must be covered. */
  readonly lines: number;
  /** Minimum percentage of branch arms that must be taken. */
  readonly branches: number;
  /** Minimum percentage of declared functions that must be invoked. */
  readonly functions: number;
}

/** The `coverageGate` block read from `package.json`. */
interface CoverageGateConfig {
  /**
   * Source locations the gate requires to appear in the report. Each entry is
   * either a directory, walked recursively for `.ts` files, or a single file.
   *
   * Prefer a directory — including `"."` for a package whose entrypoint sits at
   * the repository root. A directory is enumerated at run time, so a source file
   * added later is required automatically. An explicit file list freezes the
   * required set at the moment it was written, and a new untested module simply
   * never enters it, which is the same blind spot this gate exists to close.
   */
  readonly sources: readonly string[];
  /**
   * Directory names skipped while walking, on top of {@link DEFAULT_SKIP_DIRS}.
   * Needed only for a source tree with a non-standard non-source directory.
   */
  readonly skipDirs?: readonly string[];
  /** Test file arguments handed to `node --test`. */
  readonly tests: readonly string[];
  /** Threshold enforced on the aggregate report. */
  readonly thresholds: CoverageThresholds;
  /**
   * Source files exempt from the presence check, each of which must be
   * type-only. A module that erases to nothing emits no coverage counters, so
   * requiring it in the report would make the gate unsatisfiable.
   */
  readonly ignore?: readonly string[];
}

/** Shape of the `package.json` fields this script reads. */
interface PackageManifest {
  readonly coverageGate?: CoverageGateConfig;
}

/** One external command and any arguments that must precede gate-owned flags. */
interface CommandInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly shell?: boolean;
}

/** Injectable process and filesystem boundaries used by deterministic tests. */
interface CoverageGateRuntime {
  readonly runner?: CommandInvocation;
  readonly compiler?: CommandInvocation;
  readonly sourceCollector?: (rootDir: string, target: string, skipDirs: Set<string>) => string[];
}

/** Compiler paths used to locate a source file's emitted output. */
interface TsConfig {
  readonly compilerOptions?: { readonly outDir?: string; readonly rootDir?: string };
}

/**
 * Error thrown by helper functions to signal a gate failure with a diagnostic
 * message. {@link runCoverageGate} catches it, prints the message to stderr, and
 * returns exit code 1 — keeping the helpers free of `process.exit` so they can
 * be called from tests without terminating the test process.
 */
class CoverageGateFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoverageGateFailure";
  }
}

/**
 * Directories never treated as source, so that `sources: ["."]` works for a
 * package whose entrypoint sits at the repository root.
 *
 * These hold tests, build output, tooling and installed dependencies. None of
 * them contain shipped source, and several would otherwise make the required
 * set unsatisfiable — a test file cannot appear in its own coverage report.
 */
const DEFAULT_SKIP_DIRS: readonly string[] = [
  "node_modules",
  "dist",
  "dist-test",
  "coverage",
  "test",
  "tests",
  "scripts",
  "public",
  ".agents",
  ".git",
  ".github",
];

/**
 * Resolves the compiler's effective output paths.
 *
 * Asks `tsc --showConfig` rather than parsing `tsconfig.json` directly: the file
 * may be JSONC and may inherit `outDir`/`rootDir` through an `extends` chain, so
 * a raw `JSON.parse` can either throw on a valid config or silently read the
 * wrong paths.
 *
 * Fails closed if the compiler cannot be reached. This feeds the check that
 * decides whether an exempted module is genuinely type-only, and guessing the
 * emit layout there could clear an executable module by looking at the wrong
 * file — the one outcome this gate must never produce. A package that cannot
 * run its own compiler has a problem worth stopping for.
 */
function resolveEmitPaths(rootDir: string, command?: CommandInvocation): { outDir: string; rootDir: string } {
  // Call `tsc` directly rather than `npx tsc`: the gate always runs through
  // `npm run coverage`, which prepends `node_modules/.bin` to PATH, so the
  // compiler is already reachable. `npx` in a directory without a local
  // TypeScript install instead runs a stub that exits non-zero, which would
  // make every `ignore` entry fail in a fixture or a clean checkout.
  const compiler = command ?? { executable: "tsc", args: [], shell: process.platform === "win32" };
  const shown = spawnSync(compiler.executable, [...compiler.args, "--showConfig", "-p", "tsconfig.json"], {
    cwd: rootDir,
    encoding: "utf8",
    shell: compiler.shell ?? false,
  });
  if (shown.error || shown.status !== 0 || !shown.stdout) {
    throw new CoverageGateFailure(
      [
        "coverage-gate: could not resolve the effective tsconfig via `tsc --showConfig`,",
        "so the emit layout is unknown and `coverageGate.ignore` entries cannot be verified",
        "as type-only. Refusing to guess.",
        shown.stderr?.trim() ? `\n${shown.stderr.trim()}` : "",
      ].join("\n"),
    );
  }
  const parsed = JSON.parse(shown.stdout) as TsConfig;
  return {
    outDir: parsed.compilerOptions?.outDir ?? "dist",
    rootDir: parsed.compilerOptions?.rootDir ?? ".",
  };
}

/**
 * Collects every TypeScript source file at a configured location.
 *
 * A file entry resolves to itself; a directory entry is walked recursively with
 * {@link DEFAULT_SKIP_DIRS} pruned. Declaration files are skipped either way:
 * they carry no runtime code and so can never appear in a coverage report.
 *
 * @param rootDir - Absolute path to the package root, used for relative paths.
 * @param target - Absolute path to a source file or directory.
 * @param skipDirs - Directory names to prune during the walk.
 * @returns Repository-relative POSIX paths, in directory order.
 */
function collectSources(rootDir: string, target: string, skipDirs: Set<string>): string[] {
  if (!existsSync(target)) {
    throw new CoverageGateFailure(
      `coverage-gate: \`coverageGate.sources\` names ${relative(rootDir, target)}, which does not exist.`,
    );
  }
  if (!statSync(target).isDirectory()) {
    if (!target.endsWith(".ts") || target.endsWith(".d.ts")) {
      throw new CoverageGateFailure(
        `coverage-gate: \`coverageGate.sources\` names ${relative(rootDir, target)}, which is not a TypeScript source file. A declaration file or non-TypeScript entry can never appear in a coverage report, so requiring it would make the gate unsatisfiable.`,
      );
    }
    return [relative(rootDir, target).split(sep).join("/")];
  }
  const found: string[] = [];
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) {
        found.push(...collectSources(rootDir, join(target, entry.name), skipDirs));
      }
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      found.push(relative(rootDir, join(target, entry.name)).split(sep).join("/"));
    }
  }
  return found;
}

/**
 * Runs the coverage gate against a package root.
 *
 * Reads `package.json#coverageGate`, walks the configured sources, runs the
 * test command with V8 coverage, parses the lcov report, and reconciles the
 * reported files against the required set. Returns 0 when the gate passes and a
 * non-zero code when it fails — the same contract `process.exit` honoured in the
 * prior top-level script form, now callable from tests without terminating the
 * test process.
 *
 * @param rootDir - Absolute path to the package root to gate.
 * @param stdio - Stdio mode for the spawned test runner. Defaults to `"inherit"`
 *   so the real script streams test output. Tests pass `"ignore"` to suppress
 *   fixture output.
 * @param runtime - Optional command and source-walk boundaries used to drive
 *   process failures deterministically on every supported operating system.
 * @returns Exit code: 0 on success, 1 on a gate failure, or the test runner's
 *   non-zero status when the suite itself fails.
 */
export function runCoverageGate(
  rootDir: string,
  stdio: "inherit" | "ignore" = "inherit",
  runtime: CoverageGateRuntime = {},
): number {
  const manifest = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as PackageManifest;
  const config = manifest.coverageGate;

  if (!config) {
    console.error("coverage-gate: package.json has no `coverageGate` block.");
    return 1;
  }

  const skipDirs = new Set([...DEFAULT_SKIP_DIRS, ...(config.skipDirs ?? [])]);

  let expected: string[];
  try {
    const sourceCollector = runtime.sourceCollector ?? collectSources;
    expected = config.sources.flatMap((source) => sourceCollector(rootDir, join(rootDir, source), skipDirs));
  } catch (err) {
    if (err instanceof CoverageGateFailure) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
  const exempt = new Set(config.ignore ?? []);
  const required = expected.filter((file) => !exempt.has(file));

  // Validate every `ignore` entry is under `sources` before resolving emit
  // paths. A stale `ignore` entry pointing at a file that was removed or never
  // existed is a configuration error that should be reported on its own, not
  // masked by a tsconfig-resolution failure that happens to fire first because
  // `ignore` is non-empty.
  for (const file of config.ignore ?? []) {
    if (!expected.includes(file)) {
      console.error(`coverage-gate: \`coverageGate.ignore\` names ${file}, which is not under \`sources\`.`);
      return 1;
    }
  }

  let emitPaths: { outDir: string; rootDir: string };
  try {
    emitPaths = (config.ignore ?? []).length > 0 ? resolveEmitPaths(rootDir, runtime.compiler) : { outDir: "dist", rootDir: "." };
  } catch (err) {
    if (err instanceof CoverageGateFailure) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }

  // Rejects an `ignore` entry that still carries runtime code.
  //
  // The exemption exists for type-only modules, which erase to nothing and so
  // can never appear in a coverage report. Left untested, it is also the one
  // way to remove an executable module from both the measured set and the
  // required set — exactly the escape this gate exists to prevent. TypeScript
  // emits `export {};` and nothing else for a module that erases completely, so
  // the compiled output settles the question rather than the author's say-so.
  for (const file of config.ignore ?? []) {
    const emitted = join(
      rootDir,
      emitPaths.outDir,
      relative(join(rootDir, emitPaths.rootDir), join(rootDir, file)),
    ).replace(/\.ts$/, ".js");
    if (!existsSync(emitted)) {
      console.error(
        `coverage-gate: cannot verify that ignored file ${file} is type-only — no compiled output at ${relative(rootDir, emitted)}. Build before running the gate, or correct \`outDir\`/\`rootDir\`.`,
      );
      return 1;
    }
    // Block comments are stripped as well as line comments: tsc carries a
    // file-leading JSDoc into the emit, so a documented type-only module would
    // otherwise read as runtime code and be rejected for having a comment.
    const body = readFileSync(emitted, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/export\s*\{\s*\}\s*;?/g, "")
      .trim();
    if (body.length > 0) {
      console.error(
        `coverage-gate: \`coverageGate.ignore\` names ${file}, but it emits runtime code to ${relative(rootDir, emitted)}. Only type-only modules may be exempt; anything executable must be covered.`,
      );
      return 1;
    }
  }

  if (required.length === 0) {
    console.error("coverage-gate: source walk found no files; check `coverageGate.sources`.");
    return 1;
  }

  const lcovPath = join(rootDir, "coverage", "lcov.info");
  mkdirSync(join(rootDir, "coverage"), { recursive: true });
  // Delete any previous report first. If this run writes none, a leftover file
  // from an earlier, broader run would satisfy the presence check on stale data —
  // the gate would pass by reading history rather than by measuring anything.
  rmSync(lcovPath, { force: true });

  // Strip `NODE_TEST_CONTEXT` / `NODE_TEST_WORKER_ID`: when the gate is
  // driven from a test (this script's own test suite), the parent `node
  // --test` process sets these to coordinate with child test workers. A
  // child that inherits `NODE_TEST_CONTEXT` believes it is a recursive
  // `run()` call inside the parent's test file, skips running any test
  // files, exits 0, and writes no coverage report — so the gate fails with
  // "no coverage report was written" instead of measuring anything.
  const { NODE_TEST_CONTEXT: _dropCtx, NODE_TEST_WORKER_ID: _dropWid, ...cleanEnv } = process.env;

  const runner = runtime.runner ?? { executable: process.execPath, args: [] };
  const result = spawnSync(
    runner.executable,
    [
      ...runner.args,
      "--test",
      "--experimental-test-coverage",
      // Scope the report to exactly the files the presence check requires.
      // Passing the enumerated paths rather than a directory glob keeps the two
      // in step by construction, and keeps test files and tooling out of the
      // percentages even when the source root is the repository root.
      ...required.map((file) => `--test-coverage-include=${file}`),
      `--test-coverage-lines=${config.thresholds.lines}`,
      `--test-coverage-branches=${config.thresholds.branches}`,
      `--test-coverage-functions=${config.thresholds.functions}`,
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      "--test-reporter=lcov",
      `--test-reporter-destination=${lcovPath}`,
      ...config.tests,
    ],
    {
      cwd: rootDir,
      stdio,
      shell: runner.shell ?? false,
      // Pin the timezone so the measurement is reproducible on any machine.
      // Code that branches on a timestamp's UTC offset takes different paths
      // under a local offset than under UTC, which moves the reported
      // percentage between a contributor's machine and CI. A threshold pinned
      // to one machine's number then fails on the other for reasons unrelated
      // to the change under review.
      env: { ...cleanEnv, TZ: "UTC" },
    },
  );

  if (result.error) {
    console.error(`coverage-gate: failed to start the test runner: ${result.error.message}`);
    return 1;
  }

  // Surface a runner failure before touching the report at all. A failing
  // suite, an unmet threshold, or a test file that will not load can each leave
  // the lcov output absent or incomplete, and every diagnostic below would then
  // describe a coverage-configuration problem the author does not have —
  // burying the test failure they need to act on.
  if (result.status !== 0) {
    return result.status ?? 1;
  }

  /**
   * Source files the run actually reported on, read back from the lcov output.
   *
   * `SF:` paths are normalised to repository-relative POSIX form so they can be
   * compared against the walk. The lcov reporter emits them relative to the
   * working directory on Linux, but that is not contractual and Windows runners
   * have been seen to emit absolute paths; without normalising, the presence
   * check would invert into a permanently red build that blames every source
   * file for never loading.
   */
  const reported = new Set<string>();
  try {
    statSync(lcovPath);
    for (const line of readFileSync(lcovPath, "utf8").split("\n")) {
      if (!line.startsWith("SF:")) continue;
      const raw = line.slice(3).trim();
      const abs = isAbsolute(raw) ? raw : join(rootDir, raw);
      reported.add(relative(rootDir, abs).split(sep).join("/"));
    }
  } catch {
    console.error(`coverage-gate: no coverage report was written to ${relative(rootDir, lcovPath)}.`);
    return 1;
  }

  const missing = required.filter((file) => !reported.has(file));

  if (missing.length > 0) {
    console.error(
      [
        "",
        `coverage-gate: ${missing.length} source file(s) never loaded during the run and were`,
        "omitted from the coverage report, so the reported percentages exclude them entirely:",
        ...missing.map((file) => `  - ${file}`),
        "",
        "Import each file from a test (or exercise it through the CLI entrypoint under test).",
        "A file that is genuinely type-only belongs in `coverageGate.ignore` in package.json.",
        "",
      ].join("\n"),
    );
    return 1;
  }

  console.log(`\ncoverage-gate: ${required.length} source file(s) reported, thresholds met.`);
  return 0;
}

// ---------------------------------------------------------------------------
// Script entry point — run the gate when executed directly, not when imported.
// ---------------------------------------------------------------------------

const repoRoot = resolve(import.meta.dirname, "..");

/**
 * Runs the coverage gate when the module is the process's main script, then
 * exits with the gate's code. When the module is imported (e.g. from the test
 * suite), the `process.argv[1]` guard is false and the function returns without
 * calling `process.exit`, so tests can import and exercise every other path
 * without the module terminating the test process.
 *
 * The `rootDir` parameter defaults to the script's own parent directory (the
 * package root). Tests pass a fixture directory and mock `process.exit` so the
 * true branch — which is unreachable when the module is imported — is exercised
 * without killing the test runner.
 *
 * @param rootDir - Absolute path to the package root to gate. Defaults to the
 *   script's own parent directory.
 */
export function runScriptEntry(rootDir: string = repoRoot): void {
  // Compare canonical paths rather than just-normalised ones: `resolve` only
  // normalises `process.argv[1]`, while `fileURLToPath(import.meta.url)` reflects
  // the ESM loader's symlink-resolved path (unless --preserve-symlinks is set).
  // Without realpathSync on both sides, invoking the script through a symlinked
  // path component would leave the guard false and the gate would return
  // without running — a silent pass, which is the one outcome this gate exists
  // to prevent.
  if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
    process.exit(runCoverageGate(rootDir));
  }
}

runScriptEntry();
