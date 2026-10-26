# Sparse refresh validation

Public source: `unbraind/pm-ado`, main commit
`7f44a1dbd19ef2c9808c96944b34c41e890ebbcd`.
The source tracker was exported with `git archive` into a plain scratch directory;
all package validation ran on that copy, with git discovery capped at its parent.
`test/real-data-refresh.ts` reproduces the measurements with a supplied copy.

The SDK certified 32 items. All 69 authoritative tracker files retained identical
SHA-256 hashes, and SDK state read back after validation matched the starting
state. Derived read caches are excluded from the authoritative hash comparison.
No original tracker files were written. The public tracker has no Azure links;
the raw observation skipped 32 unlinked records and performed zero network reads.

Azure revision/base evidence was projected **in memory only** onto those public
identities. This is real-tracker validation with a synthetic Azure contract,
not live Azure acceptance or a measurement of Azure latency/response bytes.

| Scenario | Items | Probe reads | Hydration reads | Requested field cells | Unchanged | Changed | Unavailable | JSON bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Exact revisions, complete base | 32 | 1 | 0 | 0 | 32 | 0 | 0 | 1095 |
| All revisions changed | 32 | 1 | 1 | 288 | 0 | 32 | 0 | 1419 |
| Mixed observations | 32 | 1 | 1 | 72 | 17 | 8 | 7 | 1351 |

All scenarios report zero pm mutations. The measured compilation/readback section
completed in 27 ms on this run; timing is informational, not a performance gate.

`test/refresh.test.ts` additionally exercises 1000 contract items against the
existing batch client: five actual revision batch reads and five actual projected
hydration reads when all items change. Exact matches require zero hydration reads.
Every requested native field is accounted for as cached, read, unavailable or
pending, and unavailable records never yield deletion instructions. The test
checks complete JSON budgets, sparse arrays, extreme numbers and revisions,
foreign records, SDK readback, and six competing transitions across every async
boundary of the read-only observation path in one non-git tracker.

Seed `0x104525` drives 500 refresh sequences with three replay/order variants each.
Seed `0x5a17c0de` drives 500 sequences (181 imports, 152 exports, 167 syncs) with exact replays and
older input replays. A separate real SDK tracker holds the reference state;
assertions compare SDK-read fields and relationships, without a handwritten
normalizer. Coverage includes CRLF/whitespace, every native field owned by sync,
custom registry status names with active/blocked/done/canceled/draft roles,
hierarchy and related edges, local exports and remote imports.

Behavioral revert checks both failed as required: forcing eager hydration makes
the unchanged-items contract request five unwanted reads; replacing only
`runSyncCommand` with its main implementation accepts an older revision instead
of refusing it. Restored implementations pass those two regressions. Full npm
and Bun release-gate results are reported in the PR's CI checks at the final head;
coverage thresholds remain unchanged in all four dimensions.

## SDK acquisition and packed launchers

Import/export/sync and refresh preview use the host-injected client. Sync reads
status roles with `client.schemaShowStatus` only when a transition needs them.
Resolution services preserve five-argument construction and optional SDK injection; their CLI acquires the
additional history/lease primitives lazily through the host-installed SDK link,
with a canonical module anchor. No command derives SDK locations from argv, PATH
or an executable symlink. Missing resolution primitives yield a typed
`configuration` refusal with a `pm install` remedy.

`test/packed-install-shapes.test.ts` packs this package and CLI 2026.10.25, then
installs real consumers into private temporary prefixes and caches. It exercises
npm's actual global symlink, Bun's global executable, npx, bunx, the project-local
bin, and a copied tracker extension installed with `pm install` in another plain
tracker. Every shape runs actual import/export/sync and refresh preview, checks
SDK-read terminal status/revision state, and has no git executable on PATH.
Npx uses its isolated, already-primed offline package cache; it still executes
through npx, with no project-local host package to shadow the launcher.

The copied-extension regression removes only SDK links created by that temporary
fixture's install. The four client-only commands still succeed, and the separate
resolution command must report its typed installation remedy. The other five
shapes also execute resolution planning through the installed link. This covers
both lazy acquisition and the absence of launcher-based fallback.

Temporary HOME, XDG configuration, npm prefix/cache/configuration and Bun global
prefix/bin/cache all remain under the fixture root and are removed on cleanup.
Bun's explicit global directory/bin settings follow its
[documented global configuration](https://bun.sh/docs/runtime/bunfig).
No real user configuration, global package installation or Azure credential is
used or changed.


## Previous public API compatibility

The compatibility gate pins the previous published `pm-ado@2026.10.26` API from
npm. Five declaration modules and documentation hashes retain their tarball
integrity/provenance in `test/fixtures/public-api/published-provenance.json`;
no binary archive is tracked. The legacy consumer imports all 35 published value
exports and 32 type exports, including the restored deep-module
`loadResolutionSdk(anchors?)` function.

The same immutable consumer compiles against both those published declarations
and the current built declarations, then runs against current built JavaScript
under Node and Bun. Real non-git SDK trackers exercise all five constructor forms
(five arguments; explicit undefined; SDK; SDK plus observer; undefined plus
observer), legacy one-argument batch reads, and default/explicit loader anchors.
The SDK parameter remains optional and defaults only to normal package import;
there is no launcher-path fallback.

Complete current built declaration snapshots cover every module name, export and
signature. Removal or required-parameter additions fail exact snapshot comparison.
Snapshot updates are explicit and separate from the frozen published baseline:
run the build, review compatibility, then run
`node test/fixtures/public-api/update-snapshot.ts`. CI never refreshes snapshots.
