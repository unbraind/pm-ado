/** Install aliases supported by npm; this guard never executes shell input. */
const installAliases = new Set(['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add']);

/**
 * Conservatively inspect logical lines, not shell command positions. Quoted,
 * echoed and commented matches intentionally count: the inventory is our own
 * workflows, so false positives are preferable to a missed shared npm write.
 */
export function globalNpmInstalls(script: string): string[][] {
  return script.replace(/\\\r?\n/gu, '').split(/\r?\n/u).map(line =>
    line.replace(/["']/gu, '').split(/[\s;&|(){}]+/u).filter(Boolean)
  ).filter(words => {
    const global = words.some((word, index) =>
      ['-g', '--global', '--global=true', '--location=global'].includes(word) ||
      (word === '--location' && words[index + 1] === 'global') ||
      /^npm_config_global=/iu.test(word) || /^npm_config_location=global$/iu.test(word)
    );
    // Only an explicit runner-temporary prefix qualifies for the bootstrap
    // exception. An arbitrary --prefix could still name the shared toolcache.
    const local = words.some((word, index) =>
      /^\$RUNNER_TEMP\/[\w-][\w.-]*(?:\/[\w-][\w.-]*)*$/u.test(word === '--prefix' ? words[index + 1] ?? '' :
        word.replace(/^(?:--prefix=|npm_config_prefix=)/iu, '')) &&
      (word === '--prefix' || /^(?:--prefix=|npm_config_prefix=)/iu.test(word))
    );
    return global && !local && words.some((word, index) => installAliases.has(word) &&
      words.slice(index + 1).some(packageWord => packageWord === 'npm' || packageWord.startsWith('npm@')));
  });
}

/** Represent extraction failures as violations, never as a successful empty scan. */
function unreadableRun(): string[][] {
  return [['unextractable step run']];
}
/** Decode one quoted YAML scalar, rejecting unsupported or malformed values. */
function quotedScalar(value: string): string | undefined {
  const single = /^'((?:[^']|'')*)'(?:\s+#.*)?$/u.exec(value);
  if (single) return single[1].replace(/''/gu, "'");
  const double = /^"((?:[^"\\]|\\.)*)"(?:\s+#.*)?$/u.exec(value);
  if (!double) return undefined;
  const escapes: Record<string, string> = { '0': '\0', a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: '\u00a0', L: '\u2028', P: '\u2029' };
  let valid = true;
  const decoded = double[1].replace(/\\(x[\da-fA-F]{2}|u[\da-fA-F]{4}|U[\da-fA-F]{8}|.)/gu, (_match, escape: string) => {
    if (escape in escapes) return escapes[escape];
    if (/^[xuU][\da-fA-F]+$/u.test(escape)) {
      const point = Number.parseInt(escape.slice(1), 16);
      if (point <= 0x10ffff) return String.fromCodePoint(point);
    }
    valid = false;
    return '';
  });
  return valid ? decoded : undefined;
}

/** Apply YAML folding: ordinary line breaks fold, empty/more-indented lines do not. */
function blockScalar(lines: string[], indent: number, folded: boolean, chomp: string): string {
  const content = lines.map(line => line.trim() ? line.slice(indent) : '');
  let value = '';
  for (let index = 0; index < content.length; index++) {
    const line = content[index];
    const next = content[index + 1];
    value += line;
    if (!folded || next === undefined || /^\s/u.test(line) || /^\s/u.test(next)) value += '\n';
    else if (line && next) value += ' ';
    else if (!line) value += '\n';
  }
  if (chomp === '-') return value.replace(/\n+$/u, '');
  if (chomp === '+') return value;
  return value.replace(/\n*$/u, '\n');
}

/**
 * No direct YAML dependency: extract the block mapping/sequence layout used by
 * this repository. Unsupported executable layouts or run scalars fail closed.
 * Metadata scalars and nested env.run keys never become shell input.
 */
export function workflowGlobalNpmInstalls(source: string): string[][] {
  const lines = source.replace(/\r\n/gu, '\n').split('\n');
  const parents: { indent: number; path: string[] }[] = [];
  const findings: string[][] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/u.test(line)) continue;
    if (/^ *\t/u.test(line)) return unreadableRun();
    const indent = /^ */u.exec(line)![0].length;
    while (parents.length && parents[parents.length - 1].indent >= indent) {
      const last = parents[parents.length - 1];
      // YAML also permits an indentationless sequence under steps.
      if (last.indent === indent && last.path.length === 3 && last.path[0] === 'jobs' && last.path[2] === 'steps' && line.slice(indent).startsWith('- ')) break;
      parents.pop();
    }
    let parent = parents[parents.length - 1]?.path ?? [];
    let text = line.slice(indent);
    let keyIndent = indent;
    if (text.startsWith('- ')) {
      if (parent.length === 3 && parent[0] === 'jobs' && parent[2] === 'steps') {
        parent = [...parent, '*'];
        parents.push({ indent, path: parent });
      }
      text = text.slice(2);
      keyIndent += 2;
    }
    const entry = /^(?:([\w-]+)|'([^']+)'|"([^"\\]+)"):\s*(.*)$/u.exec(text);
    if (!entry) {
      if ((!parent.length && !['---', '...'].includes(text)) ||
        (parent[0] === 'jobs' && (parent.length <= 3 || (parent.length === 4 && parent[3] === '*')))) return unreadableRun();
      continue;
    }
    const key = entry[1] ?? entry[2] ?? entry[3];
    const path = [...parent, key];
    const value = entry[4].trim();
    parents.push({ indent: keyIndent, path });
    const run = path.length === 5 && path[0] === 'jobs' && path[2] === 'steps' && path[3] === '*' && key === 'run';
    const container = path[0] === 'jobs' && (path.length <= 2 || (path.length === 3 && key === 'steps'));
    if (container && value && !value.startsWith('#')) return unreadableRun();
    // Consume all block scalars, including names/metadata, before structural scanning.
    const block = /^([|>])([-+]?)(?:\s+#.*)?$/u.exec(value);
    if (block) {
      const body: string[] = [];
      while (index + 1 < lines.length && (!lines[index + 1].trim() || /^ */u.exec(lines[index + 1])![0].length > keyIndent)) body.push(lines[++index]);
      if (run) {
        const first = body.find(part => part.trim());
        if (!first) return unreadableRun();
        const contentIndent = /^ */u.exec(first)![0].length;
        if (body.some(part => part.trim() && /^ */u.exec(part)![0].length < contentIndent)) return unreadableRun();
        findings.push(...globalNpmInstalls(blockScalar(body, contentIndent, block[1] === '>', block[2])));
      }
      continue;
    }
    if (!run) continue;
    const next = lines.slice(index + 1).find(part => part.trim() && !/^\s*#/u.test(part));
    if (next && /^ */u.exec(next)![0].length > keyIndent) return unreadableRun();
    const scalar = /^["']/u.test(value) ? quotedScalar(value) :
      !value || /^[#|>&*![{]/u.test(value) || /^(?:null|true|false|~|\d+)$/u.test(value) ? undefined : value.replace(/\s+#.*$/u, '');
    if (scalar === undefined) return unreadableRun();
    findings.push(...globalNpmInstalls(scalar));
  }
  return findings;
}
