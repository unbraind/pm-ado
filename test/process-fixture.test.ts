/** Adversarial child-process contracts use Node itself as the option parser oracle. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { pathToFileURL } from "node:url";
import * as ts from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";
import { fixtureDirectory, packageRoot } from "./helpers/package-runtime.ts";
import { assertTargetPreloaded, relocateNodePreloads, runCommand, withFixturePreload } from "./helpers/process-fixture.ts";

/** Encode one NODE_OPTIONS token using Node's double-quote/backslash grammar. */
function quote(value: string): string {
  return `"${value.replace(/[\\"]/gu, "\\$&")}"`;
}

test("preload relocation preserves quoted option data and escaped paths using the native parser", async (t) => {
  const { root, cleanup } = fixtureDirectory("ado-option-oracle-");
  t.after(cleanup);
  const relocated = join(root, "child");
  mkdirSync(relocated);
  // Quote characters and control characters are valid POSIX filenames. Windows
  // still runs every flag, separator, quoting and quoted non-preload value case.
  const names = ["probe.cjs", "probe space.cjs", "probe#fragment.cjs", "probe%escape.cjs", ...(process.platform === "win32" ? [] : ['probe"quote.cjs', "probe\ttab.cjs", "probe\nline.cjs", "probe\\slash.cjs"])];
  for (const name of names) writeFileSync(join(root, name), "globalThis.fixtureProbe = (globalThis.fixtureProbe ?? 0) + 1;");
  for (const flag of ["--import", "--require", "-r"]) {
    for (const separator of flag === "-r" ? [" "] : ["=", " "]) {
      for (const [index, name] of names.entries()) {
        if (flag === "--import" && /[\\\t\n]/u.test(name)) continue;
        const title = `fixture ${flag}${separator}./decoy ${index} "quoted" \\ text`;
        const options = `--title=${quote(title)} ${flag}${separator}${quote(flag === "--import" ? `./${name.replace(/%/gu, "%25").replace(/#/gu, "%23")}` : `./${name}`)} --no-warnings`;
        const transformed = relocateNodePreloads(options, root);
        assert.equal(relocateNodePreloads(transformed, root), transformed, "relocation must be idempotent");
        if (flag === "--import") assert.ok(transformed.includes(pathToFileURL(join(root, name)).href), "every ESM spelling must become an encoded file URL");
        const source = "console.log(JSON.stringify({title:process.title, loaded:globalThis.fixtureProbe}))";
        const before = await runCommand(process.execPath, ["-e", source], { cwd: root, env: { NODE_OPTIONS: options } });
        const after = await runCommand(process.execPath, ["-e", source], { cwd: relocated, env: { NODE_OPTIONS: transformed } });
        assert.deepEqual(JSON.parse(after.stdout), JSON.parse(before.stdout), `${flag}${separator}${name}`);
        assert.deepEqual(JSON.parse(after.stdout), { title, loaded: 1 });
      }
    }
  }
  for (const options of [
    '--title="fixture -r ./decoy"', '--title="fixture --import=./decoy"',
    '--title="fixture --require ./decoy"', '--require="./unterminated', '--require="./trailing\\',
    '--import=node:fs --require=module --no-warnings',
  ]) assert.equal(relocateNodePreloads(options, root), options);
  const concatenated = '--title="fixture -r ./decoy" --require=./"probe space".cjs';
  for (const options of [concatenated, '"" --require "" "./probe space.cjs" ""']) {
    const result = await runCommand(process.execPath, ["-e", "if (globalThis.fixtureProbe !== 1) process.exit(1)"], {
      cwd: relocated, env: { NODE_OPTIONS: relocateNodePreloads(options, root) },
    });
    assert.equal(result.stderr, "");
  }
});

test("CommonJS directory preloads preserve dot and parent resolution at every flag spelling", async (t) => {
  const { root, cleanup } = fixtureDirectory("ado-directory-preload-");
  t.after(cleanup);
  const origin = join(root, "origin"), other = join(root, "elsewhere"), target = join(other, "target");
  mkdirSync(origin); mkdirSync(target, { recursive: true });
  for (const [directory, marker] of [[root, "parent"], [origin, "dot"], [other, "wrong-parent"], [target, "wrong-target"]]) {
    writeFileSync(join(directory, "package.json"), JSON.stringify({ main: "entry.cjs" }));
    writeFileSync(join(directory, "entry.cjs"), `globalThis.directoryProbe = ${JSON.stringify(marker)};`);
  }
  for (const path of [".", "..", "./", "../"]) for (const flag of ["--require=", "--require ", "-r "]) {
    const options = `--no-warnings ${flag}${quote(path)}`;
    const transformed = relocateNodePreloads(options, origin);
    assert.equal(relocateNodePreloads(transformed, origin), transformed);
    const source = "console.log(globalThis.directoryProbe)";
    const before = await runCommand(process.execPath, ["-e", source], { cwd: origin, env: { NODE_OPTIONS: options } });
    const after = await runCommand(process.execPath, ["-e", source], { cwd: target, env: { NODE_OPTIONS: transformed } });
    assert.equal(after.stdout, before.stdout, `${flag}${path}`);
    assert.equal(after.stdout.trim(), path.startsWith("..") ? "parent" : "dot");
  }
  // ESM directory imports are unsupported: preserve their native rejection.
  for (const options of ["--import=.", "--import .."])
    assert.equal(relocateNodePreloads(options, origin), options);
});

test("fixture preloads use explicit filesystem specifiers inside and outside the repository", async (t) => {
  const inside = mkdtempSync(join(packageRoot, "test/preload-inside-"));
  const outside = fixtureDirectory("ado-preload-outside-");
  t.after(() => rmSync(inside, { recursive: true, force: true }));
  t.after(outside.cleanup);
  for (const root of [inside, outside.root]) {
    const probe = join(root, "probe space.cjs");
    writeFileSync(probe, "globalThis.fixtureProbe = 1;");
    const options = withFixturePreload("--no-warnings", packageRoot, probe);
    await runCommand(process.execPath, ["-e", "if (globalThis.fixtureProbe !== 1) process.exit(1)"], {
      cwd: root, env: { NODE_OPTIONS: options },
    });
  }
});

/** A sequential wrapper must allow every declared test deadline and runner startup. */
function assertSequentialBudget(outer: number, deadlines: readonly number[]): void {
  assert.ok(outer >= deadlines.reduce((sum, deadline) => sum + deadline, 30_000),
    "outer timeout must include the combined selected test budgets plus startup");
}

test("sequential deadline audit rejects the maximum-only rule for arbitrary test counts", () => {
  for (let count = 2; count <= 20; count++) {
    const deadlines = Array.from({ length: count }, (_, index) => 110_000 + index * 1000);
    assert.throws(() => assertSequentialBudget(Math.max(...deadlines) + 30_000, deadlines));
    assert.doesNotThrow(() => assertSequentialBudget(deadlines.reduce((sum, value) => sum + value, 30_000), deadlines));
  }
});

test("target preload receipts reject stale launches, wrappers and different commands", (t) => {
  const { root, cleanup } = fixtureDirectory("ado-receipt-oracle-");
  t.after(cleanup);
  const file = join(root, "receipts.jsonl");
  const target = { cwd: root, argv: [process.execPath, join(root, "cli.js"), "ado", "import", "--json"] };
  writeFileSync(file, JSON.stringify(target) + "\n");
  const checkpoint = readFileSync(file, "utf8").length;
  const assertLoaded = () => assertTargetPreloaded(file, checkpoint, root, /[/\\\\]cli\.js$/u, target.argv.slice(2));
  assert.throws(assertLoaded, /fresh target/u);
  for (const receipt of [
    { ...target, argv: [process.execPath, join(root, "npx-cli.js"), ...target.argv.slice(2)] },
    { ...target, argv: [process.execPath, join(root, "cli.js"), "ado", "export", "--json"] },
    { ...target, cwd: join(root, "different") },
    { ...target, argv: [...target.argv.slice(0, -1), "--output-format", "toon"] },
  ]) {
    writeFileSync(file, readFileSync(file, "utf8").slice(0, checkpoint) + JSON.stringify(receipt) + "\n");
    assert.throws(assertLoaded, /fresh target/u);
  }
  writeFileSync(file, readFileSync(file, "utf8").slice(0, checkpoint) + JSON.stringify(target) + "\n");
  assert.doesNotThrow(assertLoaded);
  assert.throws(() => assertTargetPreloaded(file, checkpoint, root, /cli\.js$/u, ["ado", "import", "--output-format", "toon"]), /fresh target/u);
});

test("target preload receipts compare filesystem identities across cwd aliases", async (t) => {
  const { root, cleanup } = fixtureDirectory("ado-receipt-alias-");
  t.after(cleanup);
  const physical = join(root, "physical"), other = join(root, "other");
  mkdirSync(physical); mkdirSync(other);
  const aliases = [physical, join(root, "alias"), join(root, "chain")];
  symlinkSync(physical, aliases[1], process.platform === "win32" ? "junction" : "dir");
  symlinkSync(aliases[1], aliases[2], process.platform === "win32" ? "junction" : "dir");
  const receipt = join(root, "receipts.jsonl");
  const entry = join(physical, "cli.js");
  for (const requested of aliases) {
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { cwd: requested });
    for (const recorded of [...aliases, result.stdout]) for (const expected of aliases) {
      writeFileSync(receipt, JSON.stringify({ cwd: recorded, argv: [process.execPath, entry, "--json"] }) + "\n");
      assert.doesNotThrow(() => assertTargetPreloaded(receipt, 0, expected, /cli\.js$/u, ["--json"]));
      assert.throws(() => assertTargetPreloaded(receipt, 0, other, /cli\.js$/u, ["--json"]), /fresh target/u);
    }
  }
  // Cross-suite audits consume receipts after the child has removed its tracker.
  rmSync(physical, { recursive: true });
  writeFileSync(receipt, JSON.stringify({ cwd: physical, argv: [process.execPath, entry, "--json"] }) + "\n");
  assert.doesNotThrow(() => assertTargetPreloaded(receipt, 0, physical, /cli\.js$/u, ["--json"]));
  assert.throws(() => assertTargetPreloaded(receipt, 0, other, /cli\.js$/u, ["--json"]), /fresh target/u);
});

test("every selected-test process keeps the consumer budget plus startup allowance", (t) => {
  const fixture = mkdtempSync(join(packageRoot, "test/deadline-audit-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  writeFileSync(join(fixture, "targets.ts"), `import test from "node:test";
    test("selected first", { timeout: 120_000 }, () => {});
    test("selected second", { timeout: 120_000 }, () => {});
    test("excluded", { timeout: 900_000 }, () => {});`);
  const api = new API({ cwd: packageRoot });
  t.after(() => api.close());
  const config = join(packageRoot, "tsconfig.test.json");
  const project = api.updateSnapshot({ openProjects: [config] }).getProject(config);
  assert.ok(project);
  const program = project.program;
  /** Read test configuration as syntax, without executing the acceptance suites. */
  function sourceFile(path: string): ts.SourceFile {
    const source = program.getSourceFile(path);
    assert.ok(source, `configured source must be in the test program: ${path}`);
    return source;
  }

  /** Evaluate only numeric budget expressions and their local or imported constants. */
  function budget(expression: ts.Expression, source: ts.SourceFile): number {
    if (ts.isNumericLiteral(expression)) return Number(expression.text);
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return budget(expression.left, source) + budget(expression.right, source);
    if (ts.isIdentifier(expression)) {
      for (const statement of source.statements) {
        if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations)
          if (declaration.name.getText(source) === expression.text && declaration.initializer) return budget(declaration.initializer, source);
        if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
          const bindings = statement.importClause?.namedBindings;
          if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
            if (binding.name.text === expression.text) {
              const imported = sourceFile(resolve(source.fileName, "..", statement.moduleSpecifier.text));
              return budget(binding.propertyName ?? binding.name, imported);
            }
          }
        }
      }
    }
    assert.fail(`unrecognized timeout configuration: ${expression.getText(source)}`);
  }

  /** Locate an object's timeout without depending on its particular spelling or value. */
  function timeout(expression: ts.Expression | undefined): ts.Expression | undefined {
    if (!expression || !ts.isObjectLiteralExpression(expression)) return undefined;
    return expression.properties.find((property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && property.name.getText() === "timeout")?.initializer;
  }

  /** Discover every matching deadline, preserving distinct sequential test budgets. */
  function selectedDeadlines(target: ts.SourceFile, pattern: RegExp): number[] {
    const selectedBudgets: number[] = [];
    /** Sum the deadlines of matching sequential tests for this invocation only. */
    function deadlines(node: ts.Node): void {
      if (ts.isCallExpression(node) && node.expression.getText(target) === "test") {
        const configured = timeout(node.arguments[1]);
        if (configured) {
          const title = node.arguments[0];
          assert.ok(ts.isStringLiteral(title), "deadline-bearing selected tests need an auditable title");
          if (pattern.test(title.text)) selectedBudgets.push(budget(configured, target));
        }
      }
      node.forEachChild(deadlines);
    }
    deadlines(target);
    return selectedBudgets;
  }

  const adversarial = selectedDeadlines(sourceFile(join(fixture, "targets.ts")), /^selected/u);
  assert.equal(adversarial.length, 2, "both selected tests must contribute deadlines");
  assert.throws(() => assertSequentialBudget(210_000, adversarial), /combined/u);
  assert.doesNotThrow(() => assertSequentialBudget(270_000, adversarial));

  let checked = 0;
  let packedTargets = 0;
  for (const directory of ["test", "scripts"]) for (const entry of readdirSync(join(packageRoot, directory), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const source = sourceFile(join(entry.parentPath, entry.name));
    const selected: { file: string; pattern: RegExp }[] = [];
    const wrappers: ts.Expression[] = [];
    /** Enumerate actual nested Node test invocations and selected fixture files. */
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && node.arguments[0]?.getText(source) === "shape.binary") {
        assert.equal(node.expression.getText(source), "trackedCommand", "every packed target, including JSON/TOON and global consumers, needs a fresh entry-point receipt");
        packedTargets++;
      }
      if (ts.isArrayLiteralExpression(node) && node.elements.length >= 2 && ts.isStringLiteral(node.elements[0]) &&
        /^test\/.*\.test\.ts$/u.test(node.elements[0].text) && ts.isStringLiteral(node.elements[1]))
        selected.push({ file: node.elements[0].text, pattern: new RegExp(node.elements[1].text) });
      if (ts.isCallExpression(node) && node.arguments.some((argument) => ts.isArrayLiteralExpression(argument) &&
        argument.elements.some((element) => ts.isStringLiteral(element) && element.text === "--test"))) {
        const configured = timeout(node.arguments.at(-1));
        if (configured) wrappers.push(configured);
      }
      node.forEachChild(visit);
    }
    visit(source);
    for (const wrapper of wrappers) {
      assert.ok(selected.length > 0, `${source.fileName}: capped test wrapper needs explicit target evidence`);
      for (const { file, pattern } of selected) {
        const target = sourceFile(join(packageRoot, file));
        const selectedBudgets = selectedDeadlines(target, pattern);
        assertSequentialBudget(budget(wrapper, source), selectedBudgets);
      }
      checked++;
    }
  }
  assert.ok(packedTargets > 0, "the audit must discover the packed target invocations");
  assert.ok(checked > 0, "the audit must discover and check the real nested runner");
});

test("recorded TypeScript recovery retry declares a compatible runtime", () => {
  const item = readFileSync(resolve(packageRoot, ".agents/pm/issues/pm-ado-resolution-recovery-race.toon"), "utf8");
  assert.match(item, /Node 22\.18\+ or Node 24\+/u);
  assert.match(item, /Node 23\.0–23\.5 requires --experimental-strip-types/u);
  assert.match(item, /node --test --test-concurrency=2 --test-name-pattern=\\"resolution recovery serializes two writers\\" test\/sync\.test\.ts/u);
});

/** Extract portable grouping and reject shell syntax in unquoted option values. */
function testNamePatterns(command: string): string[] {
  const patterns: string[] = [];
  for (const match of command.matchAll(/--test-name-pattern(?:=|\s+)("(?:[^"\\]|\\.)*"|[^\s]+)/gu)) {
    const raw = match[1];
    if (raw.startsWith('"')) {
      // A closed double-quoted word without expansion: POSIX shells still substitute $ and `
      // inside double quotes, and cmd.exe substitutes %VAR%, so those are refused outright.
      assert.match(raw, /^"(?:[^"\\$`%]|\\[^$`%])*"$/u, "quoted test patterns must be closed and contain no shell expansion");
      const tail = command.slice(match.index + match[0].length);
      assert.ok(tail === "" || /^[\s`]/u.test(tail), "quoted test patterns must group the whole shell argument");
      // Shell double quotes preserve a backslash that escapes neither a quote nor
      // another backslash, so quoted regex escapes survive as written; JSON
      // semantics would wrongly reject an escape such as \d.
      patterns.push(raw.slice(1, -1).replace(/\\(.)/gsu, (escape, escaped: string) => escaped === '"' || escaped === "\\" ? escaped : escape));
    }
    else {
      assert.match(raw, /^[\p{L}\p{N}_./^:+,=\\-]+$/u, "unquoted test patterns must contain no shell metacharacters");
      patterns.push(raw);
    }
  }
  assert.ok(patterns.length > 0, "the option must have a complete pattern argument");
  return patterns;
}

/** Current executable links use grouping understood by both POSIX shells and cmd.exe. */
test("all linked test-name patterns use portable grouping", async () => {
  const pm = new PmClient({ cwd: packageRoot, pmRoot: join(packageRoot, ".agents/pm"), noExtensions: true });
  for (const separator of ["=", " "]) {
    for (const value of ["'two words'", "'a|b'", "a|b", "a;b", "a&b", "a>b", "a<b", "a(b)", "$probe", "%probe%", '"a"|b', '"a"b', "a*b", "a?b", "a[b]"])
      assert.throws(() => testNamePatterns(`node --test --test-name-pattern${separator}${value}`), value);
    for (const value of ['"a|b', '"$probe"', '"${probe}"', '"`probe`"', '"%probe%"', '"a\\$b"'])
      assert.throws(() => testNamePatterns(`node --test --test-name-pattern${separator}${value}`), value);
    for (const value of ["round-8", "^round-9", '"two words"', '"a|b"', '"a\\d"'])
      assert.equal(testNamePatterns(`node --test --test-name-pattern${separator}${value}`).length, 1);
    assert.deepEqual(testNamePatterns('node --test --test-name-pattern="a\\d and \\"b\\" [c]"'), ["a\\d and \"b\" [c]"]);
  }
  const { items } = await pm.listAllComplete();
  let checked = 0;
  for (const item of items) for (const link of item.tests ?? []) {
    if (!link.command?.includes("--test-name-pattern")) continue;
    assert.doesNotThrow(() => testNamePatterns(link.command!), item.id);
    checked++;
  }
  // Public documentation is also an executable source of test commands.
  for (const file of ["README.md", ...readdirSync(join(packageRoot, "docs")).filter((file) => file.endsWith(".md")).map((file) => `docs/${file}`)])
    for (const line of readFileSync(join(packageRoot, file), "utf8").split("\n"))
      if (line.includes("--test-name-pattern")) assert.doesNotThrow(() => testNamePatterns(line), file);
  assert.ok(checked >= 6, "the audit must read all current linked commands");
});

/** Every selector alternative must still name a test, rather than hiding behind another match. */
test("linked relation regression selects current failure and inverse behaviors independently", async () => {
  const pm = new PmClient({ cwd: packageRoot, pmRoot: join(packageRoot, ".agents/pm"), noExtensions: true });
  const { item } = await pm.get("pm-ado-1zuu", { full: true });
  const commands = (item.tests ?? []).flatMap((link) => link.command?.includes("--test-name-pattern") ? [link.command] : []);
  assert.ok(commands.length > 0);
  const source = readFileSync(join(packageRoot, "test/ado.test.ts"), "utf8");
  const titles = [...source.matchAll(/test\(\s*(?:"([^"]+)"|`([^`]+)`)/gu)].map((match) => match[1] ?? match[2]);
  for (const command of commands) for (const pattern of testNamePatterns(command)) {
    for (const alternative of pattern.split("|"))
      assert.ok(titles.some((title) => new RegExp(alternative, "u").test(title)), `stale selector: ${alternative}`);
    for (const behavior of ["forward-only relation failure keeps completed parents and never dispatches restoration", "ambiguous custom inverse pairs retain provenance without guessing"])
      assert.ok(new RegExp(pattern, "u").test(`source: ${behavior}`) && new RegExp(pattern, "u").test(`built: ${behavior}`), behavior);
  }
});
