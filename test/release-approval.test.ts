/** Keep the owner approval and tokenless provenance contract in every release. */
import { workflowGlobalNpmInstalls } from './global-npm-guard.ts';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { caller, callerSource, releaseCallerPolicy } from './helpers/release-caller.ts';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('daily and manual release triggers remain available', () => {
  assert.deepEqual(caller.on.schedule, [{ cron: '23 3 * * *' }, { cron: '41 * * * *' }]);
  assert.deepEqual(caller.on.workflow_dispatch.inputs, {
    'retire-unpublished': { description: 'Retire only owned untouched unpublished intent', type: 'boolean', default: false },
  });
  const inputs = caller.jobs.release.with;
  assert.equal(inputs['reconcile-only'], "${{ (github.event_name == 'schedule' && github.event.schedule == '41 * * * *') || inputs.retire-unpublished == true }}");
  assert.equal(inputs['retire-unpublished'], "${{ github.event_name == 'workflow_dispatch' && inputs.retire-unpublished == true }}");
});

test('the caller requires owner approval on main', () => {
  assert.equal(caller.jobs.release.with['release-enabled'], "${{ github.ref == 'refs/heads/main' && vars.PM_RELEASE_APPROVED == 'true' }}");
});

test('the README puts npm trusted publisher setup before owner approval', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const release = readme.split(/^#{1,3} /mu).find(section => section.startsWith('Daily release\n'))?.replace(/\s+/gu, ' ') ?? '';
  assert.match(release, /Configure the npm trusted publisher for `unbraind\/pm-ado` with workflow file `release\.yml` and allow direct `npm publish`\. Then set the `PM_RELEASE_APPROVED` repository variable to `true`/u);
  assert.match(release, /stops at its OIDC preflight if the publisher is missing/u);
  assert.match(release, /The variable only enables Daily Release on `main`\. npm publisher authorization is configured in npm/u);
});

test('no workflow replaces the shared global npm installation', () => {
  const workflowRoot = new URL('../.github/workflows/', import.meta.url);
  for (const entry of readdirSync(workflowRoot).sort()) {
    if (!/\.ya?ml$/u.test(entry)) continue;
    const source = readFileSync(new URL(entry, workflowRoot), 'utf8');
    assert.deepEqual(workflowGlobalNpmInstalls(source), [], entry + ' must install the pinned npm into a job-local prefix');
  }
});

test('the caller grants tokenless release permissions only to the pinned job', () => {
  const outcome = releaseCallerPolicy();
  assert.notEqual(outcome.status, 'refused', outcome.errors.join('\n'));
  assert.deepEqual(caller.permissions, {});
  assert.deepEqual(caller.jobs.release.permissions, {
    contents: 'write', 'pull-requests': 'write', actions: 'write', checks: 'read', 'id-token': 'write', issues: 'write',
  });
  assert.doesNotMatch(callerSource, /NODE_AUTH_TOKEN|NPM_TOKEN|secrets:/u);
});

test('the manifest remains public and names its catalog and public author', () => {
  assert.notEqual(manifest.private, true);
  for (const key of ['name', 'version', 'description', 'license', 'repository', 'bugs', 'engines']) assert.ok(manifest[key], key);
  assert.deepEqual(manifest.publishConfig, { access: 'public', provenance: true });
  assert.equal(manifest.homepage, 'https://pm-cli.unbrained.dev/packages/' + manifest.name);
  assert.deepEqual(manifest.author, { name: 'unbrained', url: 'https://unbrained.dev/about' });
  assert.ok(manifest.files.length > 0);
  assert.ok(readFileSync(new URL('../LICENSE', import.meta.url), 'utf8').length > 0);
});
