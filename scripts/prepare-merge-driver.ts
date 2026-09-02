/**
 * Installs pm's field-aware Git merge drivers during package preparation.
 *
 * Consumer installs may omit development dependencies and therefore have no
 * `pm` executable. That absence is an intentional no-op. Once `pm` resolves,
 * however, a failed merge-driver installation is surfaced to npm instead of
 * being mistaken for absence and silently leaving the clone unprotected.
 */

import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

/** The process result fields needed to distinguish absence from failure. */
interface CommandResult {
  readonly error?: Error;
  readonly status: number | null;
}

/** Injectable command boundary used by the deterministic unit tests. */
type CommandRunner = (
  command: string,
  args: string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly shell: boolean;
    readonly stdio: "inherit";
    readonly windowsVerbatimArguments?: boolean;
  },
) => CommandResult;

/** Injectable Windows command lookup used to separate absence from failure. */
type WindowsCommandResolver = () => string | undefined;

/**
 * Resolves the npm-provided `pm` command shim on a Windows PATH.
 *
 * Windows cannot report a missing `.cmd` through `spawnSync` once shell
 * execution is enabled: `cmd.exe` converts absence into an ordinary non-zero
 * status. Resolve the shim first so absence remains a clean consumer-install
 * no-op while a located command that fails still fails the lifecycle.
 *
 * @param pathValue - Semicolon-delimited Windows PATH value.
 * @param pathExtValue - Semicolon-delimited executable extensions.
 * @param isFile - Filesystem boundary used to verify a candidate is a file.
 * @returns The first matching absolute command path, or `undefined`.
 */
export function resolveWindowsPmCommand(
  pathValue = process.env.PATH ?? "",
  pathExtValue = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
  isFile: (candidate: string) => boolean = (candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  },
): string | undefined {
  const directories = pathValue
    .split(";")
    .map((directory) => directory.length >= 2 && directory.startsWith('"') && directory.endsWith('"')
      ? directory.slice(1, -1)
      : directory)
    .filter((directory) => directory.length > 0);
  const extensions = (pathExtValue || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.startsWith(".") ? extension : `.${extension}`)
    .filter((extension) => extension.length > 1);

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = win32.join(directory, `pm${extension}`);
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * Runs `pm merge install` and returns the lifecycle exit code.
 *
 * @param runner - Command boundary; tests inject exact success and failure
 *   results while production uses Node's synchronous process runner.
 * @param platform - Runtime platform used to select npm's Windows command shim.
 * @param resolveWindowsCommand - Windows PATH lookup boundary.
 * @returns Zero when pm is absent or installation succeeds, otherwise the
 *   command's non-zero status.
 */
export function installMergeDrivers(
  runner: CommandRunner = spawnSync,
  platform: NodeJS.Platform = process.platform,
  resolveWindowsCommand: WindowsCommandResolver = resolveWindowsPmCommand,
): number {
  const windows = platform === "win32";
  const executable = windows ? resolveWindowsCommand() : "pm";
  if (!executable) {
    return 0;
  }
  const result = windows
    ? runner(
      "cmd.exe",
      ["/d", "/v:off", "/s", "/c", '""%PM_TS_STARTER_PM_SHIM%" merge install"'],
      {
        env: { ...process.env, PM_TS_STARTER_PM_SHIM: executable },
        shell: false,
        stdio: "inherit",
        windowsVerbatimArguments: true,
      },
    )
    : runner(executable, ["merge", "install"], {
      shell: false,
      stdio: "inherit",
    });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return 0;
  }
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

/**
 * Executes the installer only when this module is Node's main script.
 *
 * @param argv - Process arguments used to identify the entry module.
 * @param runner - Command boundary forwarded to {@link installMergeDrivers}.
 * @returns The lifecycle exit code, or `undefined` when imported as a module.
 */
export function runScriptEntry(
  argv: readonly string[] = process.argv,
  runner: CommandRunner = spawnSync,
): number | undefined {
  if (!argv[1]) {
    return undefined;
  }
  if (realpathSync(resolve(argv[1])) !== realpathSync(fileURLToPath(import.meta.url))) {
    return undefined;
  }
  return installMergeDrivers(runner);
}

process.exitCode = runScriptEntry() ?? process.exitCode;
