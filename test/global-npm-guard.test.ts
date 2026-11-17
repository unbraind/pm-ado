/** Positive and negative fixtures for the workflow-wide shared-npm guard. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { globalNpmInstalls, workflowGlobalNpmInstalls } from './global-npm-guard.ts';

const rejected = [
  'npm install -g npm "--prefix $RUNNER_TEMP/npm-local"',
  'npm install -g npm "npm_config_prefix=$RUNNER_TEMP/npm-local"',
  // Round AH: run-wide signals, install families, redirects and effective prefixes.
  'export NPM_CONFIG_GLOBAL=true; npm install npm@11.21.0',
  'declare -x npm_config_location=global; npm install npm@11.21.0',
  'npm install npm@11.21.0; env NPM_CONFIG_GLOBAL=true echo ready',
  'NPM_CONFIG_LOCATION=$LOCATION; npm install npm@11.21.0',
  'NPM_CONFIG_LOCATION=$(printf global); npm install npm@11.21.0',
  'NPM_CONFIG_GLOBAL="${{ inputs.global }}"; npm install npm@11.21.0',
  'npm install-test -g npm',
  'npm it -g npm',
  'npm install-ci-test -g npm',
  'npm cit -g npm',
  'npm ci -g npm',
  'npm install -L global npm',
  'npm install -L=global npm',
  'npm install -fg npm@11.21.0',
  'npm install -g 2>&1 npm@11.21.0',
  ...['>&2', '&>output', '&>>output', '<&0'].map(redirect => `npm install -g ${redirect} npm@11.21.0`),
  'npm install -g npm # --prefix "$RUNNER_TEMP/npm-local"',
  'npm install -g npm # npm_config_prefix="$RUNNER_TEMP/npm-local"',
  'npm install --prefix "$RUNNER_TEMP/bootstrap" npm@11.21.0 && npm install -g npm@11.21.0',
  'npm install --prefix "$RUNNER_TEMP/bootstrap" npm@11.21.0 && npm install npm@11.21.0; export NPM_CONFIG_GLOBAL=true',
  'echo --prefix "$RUNNER_TEMP/npm-local" "npm install -g npm"',
  'npm install -g npm -- --prefix "$RUNNER_TEMP/npm-local"',
  'npm install -g npm npm_config_prefix="$RUNNER_TEMP/npm-local"',
  'npm install -g npm --prefix "$RUNNER_TEMP/npm-local" --prefix /shared',
  "npm install -g npm --prefix '$RUNNER_TEMP/npm-local'",
  'npm install --prefix "$RUNNER_TEMP/npm-local" npm # npm install -g npm',
  'npx npm install -g npm@latest',
  'echo "npm install -g npm@latest"',
  '# npm install -g npm@latest',
  'npm install --prefix npm -g pnpm',
  'if true; then npm install -g npm; fi',
  '(npm install -g npm)',
  'echo ready & npm install -g npm',
  'npm_config_global=true npm install npm@11.19.0',
  'NPM_CONFIG_GLOBAL=true npm install npm@11.21.0',
  'npm_config_location=global npm install npm',
  'npm --scope @x install -g npm@11.21.0',
  'npm install -g npm@11.21.0',
  ...['i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add'].map(alias => `npm ${alias} -g npm@11.21.0`),
  'npm -g install npm@11.21.0',
  'npm install npm@11.21.0 -g',
  'npm install --location=global npm@11.21.0',
  'npm install --location global npm@11.21.0',
  'npm --location global install npm@11.21.0',
  'npm install --global=true npm@11.21.0',
  'npm install -g npm',
  'npm install -g npm@latest',
  'npm install -g npm@^11',
  'npm install -gpld npm@11.19.0',
  'npm install -dg npm@11.19.0',
  'npm install --prefix "$RUNNER_TEMP/npm-11.19.0" npm@11.19.0 && npm install -g npm@11.19.0',
  'npm install --prefix "$RUNNER_TEMP/npm-local" npm@11.19.0; npm install -g npm@11.19.0',
  'npm install -g npm --prefix "$RUNNER_TEMP/npm-11.21.0" "unclosed',
  'npm install --global \\\n  npm@11.21.0',
  'npm install --global \\\r\n  npm@11.21.0',
  '"$npm_bin/npm" install --global "npm@latest"',
  '"/synthetic tool/bin/npm" install -g npm',
  "npm 'add' '--location=global' 'npm@^11'",
];
const accepted = [
  'npm install -g npm "--prefix" "$RUNNER_TEMP/npm-local"',
  'npm install -g npm --prefix="$RUNNER_TEMP/npm-local" # approved bootstrap',
  'env NPM_CONFIG_PREFIX="$RUNNER_TEMP/npm-local" NPM_CONFIG_GLOBAL=true npm install npm',
  'export NPM_CONFIG_GLOBAL=false; npm install npm',
  'NPM_CONFIG_GLOBAL=0; npm install npm',
  'NPM_CONFIG_GLOBAL=""; npm install npm',
  'NPM_CONFIG_LOCATION=project; npm install npm',
  'npm install --prefix "$RUNNER_TEMP/npm-11.21.0" npm@11.21.0 --ignore-scripts --no-audit --no-fund',
  'npm --prefix "$RUNNER_TEMP/npm-11.21.0" install npm@11.21.0',
  'npm ci',
  'npm install -g some-other-package',
  'npm install -g npm --prefix "$RUNNER_TEMP/npm-11.21.0"',
  'npm_config_prefix="$RUNNER_TEMP/npm-11.21.0" npm_config_global=true npm install npm',
  'npm install -g pnpm',
  'npm --prefix install run ci',
  'npm install --global=false npm',
  'npm install --global -- npm-helper',
  'npm install -D pnpm',
  'npm install -gpld pnpm',
  'npm install -g npm --prefix "$RUNNER_TEMP/npm-11.21.0" && npm ci',
];
for (const command of rejected) test(`rejects ${JSON.stringify(command)}`, () => {
  assert.equal(globalNpmInstalls(command).length, 1);
  const workflow = `jobs:\n  audit:\n    steps:\n      - run: |\n${command.split('\n').map(line => `          ${line}`).join('\n')}\n`;
  assert.deepEqual(workflowGlobalNpmInstalls(workflow), globalNpmInstalls(command));
  if (!command.includes('\n')) assert.deepEqual(workflowGlobalNpmInstalls(`jobs:\n  audit:\n    steps:\n      - run: ${JSON.stringify(command)}\n`), globalNpmInstalls(command));
});
for (const command of accepted) test(`allows ${JSON.stringify(command)}`, () => {
  assert.deepEqual(globalNpmInstalls(command), []);
  assert.deepEqual(workflowGlobalNpmInstalls(`jobs:\n  audit:\n    steps:\n      - run: ${JSON.stringify(command)}\n`), []);
});
test('shell punctuation and quoted text cannot hide a replacement', () => {
  for (const separator of [';', '&', '&&', '||', '|', '(', ')', '{', '}', '\n']) {
    assert.equal(globalNpmInstalls(`echo safe ${separator} npm install -g npm`).length, 1);
    if (separator !== '\n') assert.equal(globalNpmInstalls(`echo 'safe ${separator} npm install -g npm'`).length, 1);
  }
});

/** Build a minimal workflow with real step-level fields. */
function workflow(step: string): string {
  return `jobs:\n  audit:\n    steps:\n      - ${step}\n`;
}

test('all six block scalar styles are extracted with YAML folding', () => {
  for (const style of ['|', '|-', '|+', '>', '>-', '>+']) {
    const body = style.startsWith('>') ? 'npm install\n          --global\n          npm@11.19.0' : 'npm install -g npm';
    assert.equal(workflowGlobalNpmInstalls(workflow(`run: ${style}\n          ${body}`)).length, 1);
  }
  // More-indented lines and blank lines preserve logical-line boundaries.
  for (const body of ['npm install\n            --global\n          npm', 'npm install\n\n          --global npm']) {
    assert.deepEqual(workflowGlobalNpmInstalls(workflow(`run: >-\n          ${body}`)), []);
  }
});

test('only step run values are scripts, regardless of metadata quotes and run keys', () => {
  assert.equal(workflowGlobalNpmInstalls(workflow("name: Don't mutate npm\n        run: npm install -g npm")).length, 1);
  assert.deepEqual(workflowGlobalNpmInstalls(workflow('env: {run: "npm install -g npm"}\n        run: echo safe')), []);
  assert.deepEqual(workflowGlobalNpmInstalls(workflow('env:\n          run: npm install -g npm\n        run: echo safe')), []);
  assert.deepEqual(workflowGlobalNpmInstalls(workflow('name: npm install -g npm\n        run: echo safe')), []);
  assert.deepEqual(workflowGlobalNpmInstalls('env:\n  run: npm install -g npm\n' + workflow('run: echo safe')), []);
});

test('plain and quoted single-line run scalars are decoded independently', () => {
  for (const value of ['npm install -g npm', '"npm install -g npm"', "'npm install -g npm'", "'echo ''npm install -g npm'''", '"npm install\\u0020-g npm"']) {
    assert.equal(workflowGlobalNpmInstalls(workflow(`run: ${value}`)).length, 1);
  }
});

test('unextractable step run values fail closed', () => {
  for (const value of ['{script: echo safe}', '[echo safe]', 'null', '"unterminated', '*missing', '']) {
    assert.ok(workflowGlobalNpmInstalls(workflow(`run: ${value}`)).length > 0, value);
  }
});

test('unsupported executable workflow layouts fail closed', () => {
  for (const source of ['{jobs: {audit: {steps: [{run: echo safe}]}}}', 'jobs: {audit: {steps: [{run: echo safe}]}}', 'jobs:\n  audit:\n    steps:\n      - {run: echo safe}']) {
    assert.deepEqual(workflowGlobalNpmInstalls(source), [['unextractable step run']]);
  }
});

test('indentationless step sequences still inspect only step run values', () => {
  const prefix = 'jobs:\n  audit:\n    steps:\n    - env: {run: "npm install -g npm"}\n      run: ';
  assert.deepEqual(workflowGlobalNpmInstalls(prefix + 'echo safe\n'), []);
  assert.deepEqual(workflowGlobalNpmInstalls(prefix + 'npm install -g npm\n'), globalNpmInstalls('npm install -g npm'));
});

test('workflow, job and step env compose and can force installs global', () => {
  // npm reads npm_config_* case-insensitively; the step scope wins over the job.
  const envRuns = (env: string, run: string) => workflowGlobalNpmInstalls(`${env}${workflow(`run: ${run}`)}`);
  assert.equal(envRuns('env:\n  NPM_CONFIG_GLOBAL: "true"\n', 'npm install npm@11.19.0').length, 1);
  assert.equal(envRuns('env:\n  npm_config_global: ${{ matrix.global }}\n', 'npm install npm@11.19.0').length, 1);
  assert.equal(envRuns('env:\n  NPM_CONFIG_LOCATION: global\n', 'npm install npm@11.19.0').length, 1);
  assert.equal(workflowGlobalNpmInstalls(workflow('env: {NPM_CONFIG_GLOBAL: "true"}\n        run: npm install npm@11.19.0')).length, 1);
  assert.equal(workflowGlobalNpmInstalls(workflow('env: {NPM_CONFIG_LOCATION: global, NPM_CONFIG_GLOBAL: "false"}\n        run: npm install npm@11.19.0')).length, 1);
  assert.equal(workflowGlobalNpmInstalls(`jobs:\n  audit:\n    env: {NPM_CONFIG_GLOBAL: "true"}\n    steps:\n      - run: npm install npm@11.19.0\n`).length, 1);
  assert.equal(workflowGlobalNpmInstalls(`jobs:\n  audit:\n    env:\n      NPM_CONFIG_GLOBAL: "true"\n    steps:\n      - run: npm install npm@11.19.0\n`).length, 1);
  // A safe step scope overrides an unsafe job scope.
  assert.equal(workflowGlobalNpmInstalls(`jobs:\n  audit:\n    env: {NPM_CONFIG_GLOBAL: "true"}\n    steps:\n      - env: {NPM_CONFIG_GLOBAL: "false"}\n        run: npm install npm@11.19.0\n`).length, 0);
  // Only a job-local prefix inside the same segment covers a forced install.
  assert.deepEqual(workflowGlobalNpmInstalls(workflow('env: {NPM_CONFIG_GLOBAL: "true"}\n        run: npm install --prefix "$RUNNER_TEMP/npm-local" npm@11.19.0')), []);
  assert.equal(workflowGlobalNpmInstalls(workflow('env: {NPM_CONFIG_GLOBAL: "true"}\n        run: npm install --prefix "$RUNNER_TEMP/npm-local" npm@11.19.0 && npm install npm@11.19.0')).length, 1);
  // Explicitly safe values stay accepted at every level.
  assert.deepEqual(envRuns('env:\n  NPM_CONFIG_GLOBAL: "false"\n', 'npm install npm@11.19.0'), []);
  assert.deepEqual(envRuns('env:\n  NPM_CONFIG_GLOBAL: "0"\n', 'npm install npm@11.19.0'), []);
  assert.deepEqual(envRuns('env:\n  NPM_CONFIG_GLOBAL: ""\n', 'npm install npm@11.19.0'), []);
  assert.deepEqual(envRuns('env:\n  OTHER_KEY: "true"\n', 'npm install npm@11.19.0'), []);
  // Unreadable env scopes fail closed when a run installs npm.
  assert.equal(workflowGlobalNpmInstalls(workflow('env: ${{ matrix.env }}\n        run: npm install npm@11.19.0')).length, 1);
});

test('computed location values reject installs at every effective env scope', () => {
  for (const value of ['${{ inputs.location }}', "${{ 'global' }}", '$LOCATION', '$(printf global)']) {
    const entry = `NPM_CONFIG_LOCATION: ${JSON.stringify(value)}`;
    for (const source of [
      `env:\n  ${entry}\n${workflow('run: npm install npm@11.21.0')}`,
      `jobs:\n  audit:\n    env:\n      ${entry}\n    steps:\n      - run: npm install npm@11.21.0\n`,
      workflow(`env:\n          ${entry}\n        run: npm install npm@11.21.0`),
    ]) assert.equal(workflowGlobalNpmInstalls(source).length, 1, source);
  }
});

test('only actual separators isolate a sibling prefix exemption', () => {
  for (const separator of [';', '&&', '||', '|', '&', '\n']) {
    assert.equal(globalNpmInstalls(`npm install -g npm ${separator} npm install --prefix "$RUNNER_TEMP/npm-local" npm`).length, 1);
    assert.equal(globalNpmInstalls(`npm install --prefix "$RUNNER_TEMP/npm-local" npm ${separator} npm install -g npm`).length, 1);
  }
  // Quoted # is an argument; an unquoted word-start # begins a comment.
  assert.equal(globalNpmInstalls('npm install -g npm "#" --prefix /shared # --prefix "$RUNNER_TEMP/npm-local"').length, 1);
  for (const redirect of ['2>&1', '>&2', '&>output', '&>>output', '<&0']) {
    assert.equal(globalNpmInstalls(`npm install -g ${redirect} npm`).length, 1);
    // A redirect may not lend the local prefix of a sibling to an unsafe install.
    assert.equal(globalNpmInstalls(`npm install -g ${redirect} npm && npm install --prefix "$RUNNER_TEMP/npm-local" npm`).length, 1);
  }
});
