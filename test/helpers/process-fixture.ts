/** Shared real child-process execution and scoped environment restoration for native fixtures. */
import { execFile } from "node:child_process";
import { resolve } from "node:path";
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

/** Shared selected-test budget; enclosing processes must also allow startup and reporting. */
export const fixtureTestTimeoutMs = 180_000;
/** Outer deadline includes the selected test's complete budget plus runner overhead. */
export const fixtureProcessTimeoutMs = fixtureTestTimeoutMs + 30_000;

/** Keep relative Node preloads anchored without interpreting text inside other option values. */
export function relocateNodePreloads(options: string, root: string): string {
  // Match Node's NODE_OPTIONS tokenizer: spaces delimit arguments; double quotes
  // group text, and backslashes escape the next character only inside quotes.
  const tokens: { start: number; end: number; value: string }[] = [];
  for (let index = 0; index < options.length;) {
    if (options[index] === " ") { index++; continue; }
    const start = index;
    let value = "", quoted = false;
    for (; index < options.length; index++) {
      const character = options[index];
      if (character === "\\" && quoted) {
        if (++index === options.length) return options;
        value += options[index];
      } else if (character === '"') quoted = !quoted;
      else if (character === " " && !quoted) break;
      else value += character;
    }
    // Leave malformed input intact so Node reports the original syntax error.
    if (quoted) return options;
    // Node does not emit an argument for an empty quoted token.
    if (value) tokens.push({ start, end: index, value });
  }
  const edits: { start: number; end: number; value: string }[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const inline = /^(--import|--require)=(.*)$/su.exec(token.value);
    const separate = ["--import", "--require", "-r"].includes(token.value);
    const argument = separate ? tokens[++index] : token;
    const path = inline ? inline[2] : separate ? argument?.value : undefined;
    if (!argument || path === undefined || !/^\.\.?[\\/]/u.test(path)) continue;
    // NODE_OPTIONS escaping is not JSON escaping: literal newlines/tabs stay
    // literal, and only backslashes and double quotes need escaping.
    const absolute = resolve(root, path).replace(/[\\"]/gu, "\\$&");
    edits.push({ start: argument.start, end: argument.end,
      value: `${inline ? `${inline[1]}=` : ""}"${absolute}"` });
  }
  let relocated = options;
  for (const edit of edits.reverse()) relocated = relocated.slice(0, edit.start) + edit.value + relocated.slice(edit.end);
  return relocated;
}
