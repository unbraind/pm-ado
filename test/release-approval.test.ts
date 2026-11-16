/** Keep the owner approval and tokenless provenance contract in every release. */
import { workflowGlobalNpmInstalls } from './global-npm-guard.ts';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const executable = workflow.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('daily and manual release triggers remain available', () => {
  assert.match(executable, /^  schedule:\s*\n    - cron: ["']23 3 \* \* \*["']/mu);
  assert.match(executable, /^  workflow_dispatch:/mu);
});

test('every release preparation and publication job defaults to owner approval on main', () => {
  for (const name of ['prepare', 'release', 'resume_release']) {
    const block = executable.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z_]+:|$(?![\\s\\S]))`, 'mu'))?.[1];
    if (block === undefined) { assert.notEqual(name, 'release'); continue; }
    const condition = block.match(/^    if: (.+)$/mu)?.[1];
    assert.ok(condition, `${name} must gate the entire job`);
    const gate = "vars.PM_RELEASE_APPROVED == 'true'";
    const main = "github.ref == 'refs/heads/main'";
    assert.ok(condition === `${gate} && ${main}` || condition === `${main} && ${gate}` ||
      condition === `${main} && ${gate} && needs.prepare.outputs.should_release == 'true'` ||
      condition === `${main} && ${gate} && needs.prepare.outputs.resume_release_notes == 'true'`,
    `${name} must require both owner approval and main without an alternative condition`);
  }
});

test('no workflow replaces the shared global npm installation', () => {
  // A global npm install replaces the npm inside the runner's shared Node
  // installation. Parallel jobs on one host share that installation, so one
  // job's global install corrupts a sibling's npm mid-install. Every pinned
  // npm install must target a job-local prefix instead.
  const workflowRoot = new URL('../.github/workflows/', import.meta.url);
  for (const entry of readdirSync(workflowRoot).sort()) {
    if (!/\.ya?ml$/u.test(entry)) continue;
    const source = readFileSync(new URL(entry, workflowRoot), 'utf8');
    assert.deepEqual(workflowGlobalNpmInstalls(source), [], `${entry} must install the pinned npm into a job-local prefix`);
  }
});

test('publishing uses a recent npm, OIDC permission and provenance without token environments', () => {
  assert.match(executable, /^\s+id-token: write$/mu);
  const version = executable.match(/npm install --prefix "\$RUNNER_TEMP\/npm-(\d+)\.(\d+)\.(\d+)" npm@\1\.\2\.\3/u)?.slice(1).map(Number);
  assert.ok(version && (version[0] > 11 || version[0] === 11 && (version[1] > 5 || version[1] === 5 && version[2] >= 1)), 'publishing must install a trusted-publishing-capable npm into a job-local prefix');
  assert.doesNotMatch(executable, /\b(?:NODE_AUTH_TOKEN|NPM_TOKEN)\s*:/u);
  assert.doesNotMatch(executable, /secrets\.(?:NODE_AUTH_TOKEN|NPM_TOKEN)/u);
  const publishes = executable.split('\n').filter(line => /^\s*npm publish\s/u.test(line));
  assert.ok(publishes.length > 0);
  for (const line of publishes) {
    assert.match(line, /(?:^|\s)--provenance(?:\s|$)/u);
    assert.match(line, /(?:^|\s)--access public(?:\s|$)/u);
  }
});

test('the manifest remains public and names its catalog and public author', () => {
  assert.notEqual(manifest.private, true);
  for (const key of ['name', 'version', 'description', 'license', 'repository', 'bugs', 'engines']) assert.ok(manifest[key], key);
  assert.deepEqual(manifest.publishConfig, { access: 'public', provenance: true });
  assert.equal(manifest.homepage, `https://pm-cli.unbrained.dev/packages/${manifest.name}`);
  assert.deepEqual(manifest.author, { name: 'unbrained', url: 'https://unbrained.dev/about' });
  assert.ok(manifest.files.length > 0);
  assert.ok(readFileSync(new URL('../LICENSE', import.meta.url), 'utf8').length > 0);
});
