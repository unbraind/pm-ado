/** Tests the TypeScript-only, fail-loud merge-driver lifecycle guard. */

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  installMergeDrivers,
  resolveWindowsPmCommand,
  runScriptEntry,
} from "../scripts/prepare-merge-driver.ts";

/** Script path used to exercise the direct-entry branch without a subprocess. */
const SCRIPT_PATH = realpathSync(
  fileURLToPath(new URL("../scripts/prepare-merge-driver.ts", import.meta.url)),
);

test("installer runs the exact pm merge command", () => {
  const calls: unknown[][] = [];
  const code = installMergeDrivers((...args) => {
    calls.push(args);
    return { status: 0 };
  }, "linux", () => { throw new Error("Windows lookup must not run"); });

  assert.strictEqual(code, 0);
  assert.deepStrictEqual(calls, [[
    "pm",
    ["merge", "install"],
    { shell: false, stdio: "inherit" },
  ]]);
});

test("installer protects Windows shim paths from shell expansion", () => {
  const calls: unknown[][] = [];
  const code = installMergeDrivers((...args) => {
    calls.push(args);
    return { status: 0 };
  }, "win32", () => "C:\\Program Files\\npm-%USERNAME%\\pm.CMD");

  assert.strictEqual(code, 0);
  assert.deepStrictEqual(calls, [[
    "cmd.exe",
    ["/d", "/v:off", "/s", "/c", '""%PM_TS_STARTER_PM_SHIM%" merge install"'],
    {
      env: {
        ...process.env,
        PM_TS_STARTER_PM_SHIM: "C:\\Program Files\\npm-%USERNAME%\\pm.CMD",
      },
      shell: false,
      stdio: "inherit",
      windowsVerbatimArguments: true,
    },
  ]]);
});

test("installer skips Windows setup when the npm command shim is absent", () => {
  let ran = false;
  const code = installMergeDrivers(() => {
    ran = true;
    return { status: 0 };
  }, "win32", () => undefined);

  assert.strictEqual(code, 0);
  assert.strictEqual(ran, false);
});

test("Windows resolver handles quoted PATH entries and extension normalization", () => {
  const inspected: string[] = [];
  const command = resolveWindowsPmCommand(
    '"C:\\Program Files\\pm";C:\\fallback;',
    "EXE;.CMD",
    (candidate) => {
      inspected.push(candidate);
      return candidate === "C:\\Program Files\\pm\\pm.CMD";
    },
  );

  assert.strictEqual(command, "C:\\Program Files\\pm\\pm.CMD");
  assert.deepStrictEqual(inspected, [
    "C:\\Program Files\\pm\\pm.EXE",
    "C:\\Program Files\\pm\\pm.CMD",
  ]);
});

test("Windows resolver returns undefined when no candidate is a file", () => {
  assert.strictEqual(
    resolveWindowsPmCommand("C:\\bin", "", () => false),
    undefined,
  );
});

test("Windows resolver verifies a real command shim with its default filesystem boundary", (t) => {
  // This case deliberately uses the real `statSync` boundary, so the shim has to
  // exist on disk at exactly the path `win32.join` produces. On POSIX that path
  // is unavoidably cwd-relative: `win32.join` emits a backslash, which POSIX
  // treats as an ordinary filename character, so even an absolute `/tmp/x`
  // becomes the *relative* name `\tmp\x\pm.CMD`. Passing an absolute directory
  // therefore does not move the file out of the repository - it only renames it.
  //
  // So scope the cwd instead. Left at the repository root, the shim is created
  // where the docstring gate's directory walk runs, and `t.after` deletes it
  // mid-walk, failing the gate with ENOENT between its readdir and its stat.
  // That surfaced as `test (26)` failing while `test (22)` passed, which reads
  // as flake rather than as one test writing into another's scan path.
  const scratch = mkdtempSync(join(tmpdir(), "pm-windows-resolver-"));
  const previousCwd = process.cwd();
  process.chdir(scratch);
  t.after(() => {
    process.chdir(previousCwd);
    rmSync(scratch, { recursive: true, force: true });
  });

  const directory = "shim";
  const candidate = win32.join(directory, "pm.CMD");
  writeFileSync(candidate, "");

  assert.strictEqual(resolveWindowsPmCommand(directory, ".CMD"), candidate);
});

test("Windows resolver treats a missing real command shim as absent", () => {
  assert.strictEqual(
    resolveWindowsPmCommand(`pm-windows-missing-${process.pid}-${Date.now()}`, ".CMD"),
    undefined,
  );
});

test("Windows resolver reads process defaults when PATH inputs are omitted", () => {
  assert.strictEqual(resolveWindowsPmCommand(undefined, undefined, () => false), undefined);
});

test("Windows resolver tolerates a missing process PATH", (t) => {
  const pathValue = process.env.PATH;
  delete process.env.PATH;
  t.after(() => {
    if (pathValue === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = pathValue;
    }
  });

  assert.strictEqual(resolveWindowsPmCommand(undefined, ".CMD", () => false), undefined);
});

test("installer silently skips a genuinely absent pm executable", () => {
  const error = Object.assign(new Error("missing"), { code: "ENOENT" });
  assert.strictEqual(installMergeDrivers(() => ({ error, status: null })), 0);
});

test("installer surfaces a present but broken executable", () => {
  const error = new Error("broken executable");
  assert.throws(
    () => installMergeDrivers(() => ({ error, status: null })),
    error,
  );
});

test("installer preserves a non-zero pm status", () => {
  assert.strictEqual(installMergeDrivers(() => ({ status: 17 })), 17);
});

test("installer fails closed when a process returns no status", () => {
  assert.strictEqual(installMergeDrivers(() => ({ status: null })), 1);
});

test("entry guard declines a missing argv path", () => {
  assert.strictEqual(runScriptEntry(["node"]), undefined);
});

test("entry guard declines an imported module", () => {
  assert.strictEqual(runScriptEntry(["node", import.meta.dirname]), undefined);
});

test("entry guard runs the installer for the main script", () => {
  assert.strictEqual(
    runScriptEntry(["node", SCRIPT_PATH], () => ({ status: 0 })),
    0,
  );
});
