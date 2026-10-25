# SDK adoption evidence (2026-10-25)

Tracker: [pm-ado-sdk-adoption](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/chores/pm-ado-sdk-adoption.toon).
Related certification: [pm-ado-qq1p](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/chores/pm-ado-qq1p.toon).
Baseline build: `origin/main` at `7f44a1dbd19ef2c9808c96944b34c41e890ebbcd`.
Pinned SDK stays at `2026.10.23`.

| Audit finding (baseline lines) | SDK replacement | Behavioural evidence |
| --- | --- | --- |
| `resolution.ts:196-199`: prefix-only authoritative lookup | `readSettings` item format and `resolveItemTypeRegistry` folders passed to `locateItem`; retain `readLocatedItem` | Custom nested-folder lookup works without git; raw whole-document digest matches; later body edit refuses apply. Reverting only `document` and rebuilding fails the lookup regression (1 failed test). |
| `sync.ts:382`: unguarded update after snapshot comparison | `commitItemMutations` update `match` on inspected `updated_at`; link/relation/base writes all use it | Local edits after PATCH or during the batch read survive byte-for-byte and return exit 4. Replacing only the local update helper with ordinary `pm.update` and rebuilding fails both race regressions (2 failed tests). |

Restoring the replacements and rebuilding passes all four targeted tests
(the three regressions plus terminal-state compatibility).

## Differential method

`scripts/sdk-adoption-differential.ts` accepts a separately built baseline package
and at least two public tracker snapshot roots:

```sh
node scripts/sdk-adoption-differential.ts "$BASELINE_BUILD" "$ADO_TRACKER_SNAPSHOT" "$JIRA_TRACKER_SNAPSHOT"
```

Build the baseline from the recorded commit with the package's pinned dependency
graph. Export tracker inputs with `git archive` from public repository refs, then
pass the exported tracker directories. The script never writes those sources.
It installs the candidate extension only in disposable non-git copies, seeds one
synthetic Azure link per corpus, and serves a local read-only Azure REST fixture.
Both builds run in separate processes with `GIT_CEILING_DIRECTORIES` and a `PATH`
containing no git executable.

Public inputs used:

| Repository | Ref | Real items |
| --- | --- | ---: |
| `unbraind/pm-ado` | `7f44a1dbd19ef2c9808c96944b34c41e890ebbcd` | 32 |
| `unbraind/pm-jira` | `2fd1537c8d0df5755d0d4ba86f06eda59a3c644e` | 108 |

Results: 14 comparisons across 140 real items. Import/export/sync dry-run
receipts and resolution plans match exactly on read-only copies, with identical
authoritative bytes before and after. Actual import runs on separate writable
copies; command receipts, final item values and history operation/author/patch
projections match after normalizing only mutation timestamps. History length
also matches. No public tracker contents or temporary fixture files are checked
in.

Intentional differences:

- Concurrent local changes now refuse persistence with `ADO_CONFLICT` (exit 4)
  instead of overwriting the newer item. SDK persistence conflicts such as
  ownership/lock refusals also use that receipt instead of a generic remote
  error. Earlier remote writes can remain.
- SDK update history messages use mandatory `bulk-item-transaction` markers in
  place of adapter prose; the differential asserts each expected message form.
  SDK journals remain ignored runtime state.
- Configured nested type folders now resolve instead of returning a scope
  refusal. The raw document hash is unchanged for existing supported items.

## SDK gap

[pm-ado-sdk-match-close-1025](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-sdk-match-close-1025.toon)
records a pinned SDK limitation for the orchestrator to report upstream: an
update's timestamp match also runs during its internal terminal close, after
its preliminary write has changed the timestamp. The package now uses two separately matched SDK update commits: a scalar
update followed by a status-only update, carrying forward the prior revision.
The original unguarded close workaround was rejected in review and replaced.
A match consumed once per top-level update, or a match on a close mutation,
would remove this workaround. Both audit findings are replaced; none deferred.

The failing SDK shape is an update mutation with `options.status: "closed"`,
other scalar changes, a close reason, and `match: { key: "updated_at", value:
inspected.updated_at }` against an open item. The SDK returns
`upsert_match_changed` during the internal close despite there being no other
writer. `BulkItemCloseMutation.match` is currently absent.

## Local release gates

Both `npm run release:check` and `bun run release:check` pass with an isolated
Git identity (`HOME` set to a fresh disposable directory,
`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`). Each runs 230 tests
in both V8 and independent statement-instrumented passes, with zero
failures/skips. All eight required source files have 100% statements, lines,
branches and functions; statements are 1381/1381. The gates also pass
typecheck/build, 90/90 documented declarations, zero production audit
vulnerabilities, pack, changelog, publish-attestation and date checks.
Pinned-pm linked tests pass 2/2. Isolated-identity strict tracker health and
`git diff --check` pass. The repository has no standalone lint script.

Sync author attribution also uses `selectImportAuthor` with the configured
`readSettings.author_default`, preserving the canonical explicit/environment/
configured author precedence. The configured-default regression and final
lookup/race/terminal/error checks pass 5/5; the public differential was repeated
after this adjustment and still passes all 14 comparisons.

PR: [46](https://github.com/unbraind/pm-ado/pull/46). The initial published
head passed all four CI jobs (Node 22, Node 26, npm release gate, Bun release
gate); final-head results are linked from the PR checks. The adoption claim is
released for orchestrator verification; neither pm item is closed.

## Blocking review follow-up

The initial CI evidence above belongs to the initial adoption commits. The
review repairs, durable outbox, process-crash matrix and remaining provider
constraint are documented in [sync recovery](sync-recovery.md). New gate and
revert evidence is appended to the adoption item; earlier evidence is retained.
