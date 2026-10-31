/** Shared real child-process execution and scoped environment restoration for native fixtures. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Preserve Node's actual executable, buffer and failure semantics in every host fixture. */
export const runCommand = promisify(execFile);

/** Restore only the fixture-owned variable names, including their original absence. */
export function restoreEnvironment(before: Readonly<Record<string, string | undefined>>, keys: readonly string[]): void {
  for (const key of keys) {
    if (before[key] === undefined) delete process.env[key];
    else process.env[key] = before[key];
  }
}
