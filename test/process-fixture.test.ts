/** Adversarial child-process contracts use Node itself as the option parser oracle. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import * as ts from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";
import { fixtureDirectory, packageRoot } from "./helpers/package-runtime.ts";
import { relocateNodePreloads, runCommand } from "./helpers/process-fixture.ts";

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
  const names = ["probe.cjs", "probe space.cjs", ...(process.platform === "win32" ? [] : ['probe"quote.cjs', "probe\ttab.cjs", "probe\nline.cjs", "probe\\slash.cjs"])];
  for (const name of names) writeFileSync(join(root, name), "globalThis.fixtureProbe = (globalThis.fixtureProbe ?? 0) + 1;");
  for (const flag of ["--import", "--require", "-r"]) {
    for (const separator of flag === "-r" ? [" "] : ["=", " "]) {
      for (const [index, name] of names.entries()) {
        if (flag === "--import" && /[\\\t\n]/u.test(name)) continue;
        const title = `fixture ${flag}${separator}./decoy ${index} "quoted" \\ text`;
        const options = `--title=${quote(title)} ${flag}${separator}${quote(`./${name}`)} --no-warnings`;
        const transformed = relocateNodePreloads(options, root);
        assert.equal(relocateNodePreloads(transformed, root), transformed, "relocation must be idempotent");
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

test("every selected-test process keeps the consumer budget plus startup allowance", (t) => {
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

  let checked = 0;
  for (const directory of ["test", "scripts"]) for (const entry of readdirSync(join(packageRoot, directory), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const source = sourceFile(join(entry.parentPath, entry.name));
    const selected = new Set<string>();
    const wrappers: ts.Expression[] = [];
    /** Enumerate actual nested Node test invocations and selected fixture files. */
    function visit(node: ts.Node): void {
      if (ts.isStringLiteral(node) && /^test\/.*\.test\.ts$/u.test(node.text)) selected.add(node.text);
      if (ts.isCallExpression(node) && node.arguments.some((argument) => ts.isArrayLiteralExpression(argument) &&
        argument.elements.some((element) => ts.isStringLiteral(element) && element.text === "--test"))) {
        const configured = timeout(node.arguments.at(-1));
        if (configured) wrappers.push(configured);
      }
      node.forEachChild(visit);
    }
    visit(source);
    for (const wrapper of wrappers) {
      assert.ok(selected.size > 0, `${source.fileName}: capped test wrapper needs explicit target evidence`);
      let selectedBudget = 0;
      for (const file of selected) {
        const target = sourceFile(join(packageRoot, file));
        /** Include every declared test deadline in each selected file. */
        function deadlines(node: ts.Node): void {
          if (ts.isCallExpression(node) && node.expression.getText(target) === "test") {
            const configured = timeout(node.arguments[1]);
            if (configured) selectedBudget = Math.max(selectedBudget, budget(configured, target));
          }
          node.forEachChild(deadlines);
        }
        deadlines(target);
      }
      assert.ok(budget(wrapper, source) >= selectedBudget + 30_000,
        `${source.fileName}: outer timeout must include every selected test budget plus startup`);
      checked++;
    }
  }
  assert.ok(checked > 0, "the audit must discover and check the real nested runner");
});

test("recorded TypeScript recovery retry declares a compatible runtime", () => {
  const item = readFileSync(resolve(packageRoot, ".agents/pm/issues/pm-ado-resolution-recovery-race.toon"), "utf8");
  assert.match(item, /Node 22\.18\+ or Node 24\+/u);
  assert.match(item, /Node 23\.0–23\.5 requires --experimental-strip-types/u);
  assert.match(item, /node --test --test-concurrency=2 --test-name-pattern='resolution recovery serializes two writers' test\/sync\.test\.ts/u);
});
