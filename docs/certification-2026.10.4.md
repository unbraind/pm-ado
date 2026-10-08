# PM CLI/SDK 2026.10.4 certification candidate

PM: [certification pm-ado-qq1p](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/chores/pm-ado-qq1p.toon), [statement enforcement pm-ado-5w3m](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-5w3m.toon).

## Changes

Exact development pins: CLI/SDK, pm-ops, pm-changelog 2026.10.4; Node types 26.6.4; TypeScript 7.0.2. Peer and manifest floors are preserved. There were no open Dependabot PRs. CodeQL moves to exact SHA `2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2` with `# v4.38.2` comment, as verified from the current Dependabot action update. The owner release job guard `vars.PM_RELEASE_APPROVED == 'true' && github.ref == 'refs/heads/main'` is unchanged; no publish, release, tag, approval-variable change or workflow dispatch. The package version remains 2026.9.2 and is unpublished.

The new real invalid-NODE_PATH-file test fails the old launcher with ENOTDIR replacing the original installer error. Copying `node_modules/pm-ops/templates/prepare-merge-driver.ts` byte-for-byte makes it preserve MODULE_NOT_FOUND and passes 8/8 launcher tests, zero skipped. No template edits or threshold changes.

## Gate results and coverage boundary

`npm run release:check` passed: 123/123 tests, zero skipped, 100% measured lines/branches/functions across 4 sources; full docstring, production audit, pack contents, changelog, publish-attestation and release-date checks passed. Both `npm audit --omit=dev` and `npm audit` report zero vulnerabilities; open Dependabot alerts response was `[]`. CI's `bun install --no-save` passed under the same heavy lock. `npx pm health --strict-exit --require-merge-drivers --json` reports ok=true with no warnings. Linked launcher suite through `pm test --run --progress` passed 8/8.

At this certification snapshot, statements=100 was declared but independently unmeasured. The statement gate is now implemented in `pm-ado-5w3m`; see [statement-coverage evidence](statement-coverage.md) for its independent AST counters, regression tests and current gate receipts. The historical three-metric result above remains the evidence for that earlier snapshot. Thresholds and release approval controls are preserved.

## Packed real-tracker dogfood

Under the shared heavy lock, `../dogfood-ado.sh` ran `npm pack`, installed the archive and CLI 2026.10.4 into a disposable copy of the real tracker, and exercised the only shipped command, offline `ado validate`, with both npm npx and native Bun bunx. It explicitly clears inherited Azure credentials for the missing-config case and uses a public synthetic token for the configured case. The command performs no Azure network call. Both runtimes return identical JSON, report all 3 missing inputs, and validate the synthetic config while hiding its token. Scratch deleted. No live Azure sync/import/export or revision-reconciliation acceptance is claimed; those commands are not yet registered.

Exact commands and observed outputs:

```text
+ env -u ADO_ORG_URL -u ADO_PROJECT -u ADO_TOKEN npx -y @unbrained/pm-cli@2026.10.4 ado validate --json
+ cat npm-unconfigured.json
{
  "ok": false,
  "org_url": null,
  "project": null,
  "token_present": false,
  "missing": [
    "ADO_ORG_URL",
    "ADO_PROJECT",
    "ADO_TOKEN"
  ],
  "batch_limit": 200,
  "writes_assert_revision": true
}
+ env -u ADO_ORG_URL -u ADO_PROJECT -u ADO_TOKEN bunx --bun -y @unbrained/pm-cli@2026.10.4 ado validate --json
+ cat bun-unconfigured.json
{
  "ok": false,
  "org_url": null,
  "project": null,
  "token_present": false,
  "missing": [
    "ADO_ORG_URL",
    "ADO_PROJECT",
    "ADO_TOKEN"
  ],
  "batch_limit": 200,
  "writes_assert_revision": true
}
+ env ADO_ORG_URL=https://dev.azure.com/certification-fixture ADO_PROJECT=offline-certification ADO_TOKEN=synthetic-not-a-credential npx -y @unbrained/pm-cli@2026.10.4 ado validate --json
+ cat npm-configured.json
{
  "ok": true,
  "org_url": "https://dev.azure.com/certification-fixture",
  "project": "offline-certification",
  "token_present": true,
  "missing": [],
  "batch_limit": 200,
  "writes_assert_revision": true
}
+ env ADO_ORG_URL=https://dev.azure.com/certification-fixture ADO_PROJECT=offline-certification ADO_TOKEN=synthetic-not-a-credential bunx --bun -y @unbrained/pm-cli@2026.10.4 ado validate --json
+ cat bun-configured.json
{
  "ok": true,
  "org_url": "https://dev.azure.com/certification-fixture",
  "project": "offline-certification",
  "token_present": true,
  "missing": [],
  "batch_limit": 200,
  "writes_assert_revision": true
}
{"npmBunParity":true,"unconfiguredFailsClosed":true,"configuredOfflineValid":true,"tokenRedacted":true}
```

## Managed GitHub preview

Installed managed `npm:pm-github@2026.10.4`; `pm github sync --repo unbraind/pm-ado --dry-run` reports no provenance-linked items and synced=0/skipped=0/planned=0. Zero-case preview evidence; no GitHub issue writes or scheduled sync. Final-head CI and substantive reviews remain separate from local evidence. The orchestrator owns merging and PM closure.

## Review follow-up

Managed extension payloads are clone-local installed distributions and are excluded from Git. Reproduce the read-only preview with `npx -y @unbrained/pm-cli@2026.10.4 package install npm:pm-github@2026.10.4 --project`, then `npx -y @unbrained/pm-cli@2026.10.4 github sync --repo unbraind/pm-ado --dry-run`. The installed version and zero-case receipt above remain the evidence; no write-path acceptance is claimed.
