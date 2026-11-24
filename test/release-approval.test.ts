/** Keep the owner approval and tokenless provenance contract in every release. */
import { workflowGlobalNpmInstalls } from './global-npm-guard.ts';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { caller, callerSource, canonicalRelease, executable, releaseStep } from './helpers/release-caller.ts';

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

test('every release preparation and publication job requires owner approval on main', async () => {
  assert.equal(caller.jobs.release.with['release-enabled'], "${{ github.ref == 'refs/heads/main' && vars.PM_RELEASE_APPROVED == 'true' }}");
  const { jobs } = await canonicalRelease();
  for (const name of ['reconcile', 'prepare', 'request', 'release', 'recover']) {
    const condition = jobs[name].if;
    assert.match(condition, /^inputs\.release-enabled && github\.ref == 'refs\/heads\/main'(?: && |$)/u, name);
    assert.doesNotMatch(condition, /\|\|/u, name);
  }
});

test('no workflow replaces the shared global npm installation', async () => {
  const workflowRoot = new URL('../.github/workflows/', import.meta.url);
  for (const entry of readdirSync(workflowRoot).sort()) {
    if (!/\.ya?ml$/u.test(entry)) continue;
    const source = readFileSync(new URL(entry, workflowRoot), 'utf8');
    assert.deepEqual(workflowGlobalNpmInstalls(source), [], entry + ' must install the pinned npm into a job-local prefix');
  }
  assert.deepEqual(workflowGlobalNpmInstalls((await canonicalRelease()).source), []);
});

test('publishing uses a recent npm, OIDC permission and provenance without token environments', async () => {
  assert.deepEqual(caller.permissions, {});
  assert.deepEqual(caller.jobs.release.permissions, {
    contents: 'write', 'pull-requests': 'write', actions: 'write', checks: 'read', 'id-token': 'write', issues: 'write',
  });
  const { jobs } = await canonicalRelease();
  assert.equal(jobs.release.permissions['id-token'], 'write');
  const bootstrap = executable(releaseStep(jobs.release, 'Use an npm that supports trusted publishing').run);
  const version = bootstrap.match(/npm install --prefix "\$RUNNER_TEMP\/npm-(\d+)\.(\d+)\.(\d+)" npm@\1\.\2\.\3/u)?.slice(1).map(Number);
  assert.ok(version && (version[0] > 11 || version[0] === 11 && (version[1] > 5 || version[1] === 5 && version[2] >= 1)), 'publishing must install a trusted-publishing-capable npm into a job-local prefix');
  const publish = releaseStep(jobs.release, 'Publish npm package');
  const source = JSON.stringify([callerSource, jobs.release.env, publish.env]);
  assert.doesNotMatch(source, /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\s*(?:[:.]|\[)/u);
  const publishes = executable(publish.run).split('\n').filter(line => /^\s*npm publish\s/u.test(line));
  assert.ok(publishes.length > 0);
  for (const line of publishes) {
    assert.match(line, /(?:^|\s)--provenance(?:\s|$)/u);
    assert.match(line, /(?:^|\s)--access public(?:\s|$)/u);
  }
});

test('the job-local npm prefix is published to GITHUB_PATH and verified by exact version', async () => {
  const { jobs } = await canonicalRelease();
  for (const job of [jobs.prepare, jobs.release]) {
    const bootstrap = executable(releaseStep(job, 'Use an npm that supports trusted publishing').run);
    const install = bootstrap.match(/^\s*npm install --prefix "\$RUNNER_TEMP\/(npm-([\d.]+))" npm@\2(?=\s|$)/mu);
    assert.ok(install, 'the release workflow must install the pinned npm into a job-local prefix');
    const [, directory, version] = install;
    assert.ok(bootstrap.includes('echo "$RUNNER_TEMP/' + directory + '/node_modules/.bin" >> "$GITHUB_PATH"'));
    const verify = releaseStep(job, 'Verify job-local npm version');
    assert.equal(verify.run, 'test "$(npm --version)" = "' + version + '"');
  }
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
