# SDK adoption evidence (2026-10-25)

**Escalated review remains blocked:** the proposed lock-only replacement cannot
protect ordinary SDK writers in either pinned SDK `2026.10.25` or published SDK
`2026.10.28`. See the cross-process capability assessment below. The recovery
finding involving an intent compensation record remains unresolved; the earlier
passing gates do not establish that it is fixed.

**Retained implementation (R9):** native writes use SDK lifecycle operations
inside `commitWorkspaceTransaction`, with history-head verification and
selective compensation under `mutateItemWithHistoryContext`. Fixed-clock and
ABA edits now refuse with typed conflicts and retain peer state. This is the
owner-authorized detect-after-write fallback for
[pm-cli#1576](https://github.com/unbraind/pm-cli/issues/1576); it does not claim
the SDK has gained a pre-write conditional lifecycle API. R7's failing probe
and limitation report below are historical and superseded by this fallback.
New-item continuations bind the immutable SDK create receipt and birth event;
they never adopt a later post-create peer head as their own baseline.

Tracker: [pm-ado-sdk-adoption](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/chores/pm-ado-sdk-adoption.toon).
Related certification: [pm-ado-qq1p](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/chores/pm-ado-qq1p.toon).
Baseline build: `origin/main` at `7f44a1dbd19ef2c9808c96944b34c41e890ebbcd`.
SDK adoption initially used `2026.10.23`; the toolchain update merged from
`origin/main` for the presence review pins `2026.10.24`.

| Audit finding (baseline lines) | SDK replacement | Behavioural evidence |
| --- | --- | --- |
| `resolution.ts:196-199`: prefix-only authoritative lookup | `readSettings` item format and `resolveItemTypeRegistry` folders passed to `locateItem`; retain `readLocatedItem` | Custom nested-folder lookup works without git; raw whole-document digest matches; later body edit refuses apply. Reverting only `document` and rebuilding fails the lookup regression (1 failed test). |
| `sync.ts:382`: unguarded update after snapshot comparison | SDK lifecycle `update` inside `commitWorkspaceTransaction`, verified/compensated with `mutateItemWithHistoryContext` and SDK history replay. `commitItemMutations.match` cannot express the required native head (#1576), so its timestamp-only form was replaced by the approved R8 fallback. | Fixed-clock ordinary/ABA cases refuse at all nine selected write boundaries. Reverting the shared history predicates in a disposable copy fails all 18 cases (19 failures including parent); restoring them passes 19/19. Original distinct-timestamp and lookup revert proofs remain below. |

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
receipts and resolution plans match on read-only copies after excluding the documented
optional canonical-coordinate marker, with identical
authoritative bytes before and after. Actual import runs on separate writable
copies; command receipts, final item values and net history operation/author/patch
projections match after normalizing mutation timestamps and patch path order.
The candidate records three conditional events (prepare local intent,
scalar/provenance, then read-back agreement) where the baseline records one;
the script asserts these counts. No public tracker contents or temporary fixture files are checked
in.

Intentional differences:

- Concurrent local changes now refuse persistence with `ADO_CONFLICT` (exit 4)
  instead of overwriting the newer item. SDK persistence conflicts such as
  ownership/lock refusals also use that receipt instead of a generic remote
  error. Earlier remote writes can remain.
- SDK update history messages use mandatory `bulk-item-transaction` markers in
  place of adapter prose; the differential asserts each expected message form.
  Local intent preparation and agreement publication have separate guarded
  events; transient intent patches are excluded from the net history patch,
  whose final synced values and author remain identical. The differential also excludes the newly stored
  internal per-key witnessed revision coordinates and explicit field-presence sets
  from synced base values.
  SDK journals remain ignored runtime state.
- New resolution plans carry the optional `pm-ado/fields/1` canonical-coordinate
  marker; the differential asserts and removes only this additional marker.
  Status aliases and mapping spellings now compare as their native SDK values.
- Configured nested type folders now resolve instead of returning a scope
  refusal. The raw document hash is unchanged for existing supported items.

## SDK gap

[pm-ado-sdk-match-close-1025](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-sdk-match-close-1025.toon)
records a pinned SDK limitation for the orchestrator to report upstream: an
update's timestamp match also runs during its internal terminal close, after
its preliminary write has changed the timestamp. The package uses separately matched SDK updates: scalars excluding agreement,
a status-only close, explicit mapped assignment completion when needed, then
per-key read-back base/revision publication last. Each carries forward
the preceding revision; crash recovery resumes with ordinary three-way sync.
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


## Round-5 normalization class

`normalization.ts` exports the shared field functions; `sync.ts` projections,
three-way merge, agreement read-back and pending recovery, `resolution.ts`
plan/apply/replay, contract discovery, move selection and scope checks call
them. `remoteScalarValues` is the shared read-back projection. Import aliases
are independent of reverse export mappings. New plans canonicalize semantic
field coordinates and mapping interpretation, while released plans/intents
and wire identities preserve their original integrity coordinates.

Adversarial coverage includes every configured builtin mapping, custom status
aliases (including a prototype-like status name), SDK-accepted case, padding,
nonbreaking whitespace and hyphen spellings: 120 choose/apply/replay cases,
with no Azure PATCH or state reversal. Native SDK write-oracle tests cover
scalar clear tokens, literal Unicode/whitespace, tag ordering and priorities.
JSON/TOON plans and replay accept native prefixed/hash-marker ID spellings;
read-only contracts and moves also work without a module link in non-git
trackers. Explicit SDK injection also owns normalization without a package module
link; new plan scope fingerprints compare canonical organization/project values,
while released fingerprints and outbox/wire identities stay literal. The packed installation matrix repeats resolution apply/replay for
the import-only `Done` alias. Actual released prepared/settled fixtures verify
old-artifact reads, pending recovery and replay without rewriting history.

[pm-ado-sdk-scalar-normalization](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-sdk-scalar-normalization.toon)
records the missing public `isLegacyNoneToken` or
`normalizeAssigneeMutationInput` export. SDK trimming is public; the SDK's
assignment clear-token predicate is private. This small centralized adapter
predicate is verified against actual native writes. The orchestrator files
the upstream API request; neither original audit replacement is deferred.


Function-only normalization revert evidence (rebuild before execution):

| Reverted behavior | Selected regression result | Restored result |
| --- | --- | --- |
| Status normalizer returns the input spelling | 3 failed / 3: Done/CLOSED read-back, SDK alias property, host contract | 5/5 combined status/ID cases pass |
| ID normalizer returns the operator spelling | 1 failed / 2: host move aliases; artifact path independently uses native lookup | 5/5 combined status/ID cases pass |
| Scope normalizer returns the input spelling | 4 failed / 4: scalar oracle, contract, moves, injected SDK | 4/4 pass |
| Agreement raw-ID projection falls back to package SDK lookup | 1 failed / 1: isolated runtime with explicit native SDK injection | 4/4 combined scope/injection cases pass |

Final focused normalization/API checkpoint: 7/7 pass, including the unchanged
published consumer under Node and Bun; the complete new normalizer module
measures 100% lines, branches and functions. The linked spelling suite separately
passes 10/10 tests and all 120 choose/apply/replay cases. Full package coverage
retains its independent statement gate and unchanged 100% thresholds.


## Latest validation and remaining CI evidence

Implementation source: `524d6cb2f55e4f1d96f5a7a83e969814c331039a`.
Main was merged through `676eb69e1be19692e0588c0246163783259255a6`.
Both audit findings are replaced: seven original replacement lines removed;
the complete production TypeScript diff deletes 163 lines against that main.

Separate, overlapping focused checkpoints passed: 50/50 resolution/graph cases;
10/10 linked normalization cases including 120 native SDK/map spelling
choose/apply/replay cases; 7/7 final normalization/API cases with 100% new-module
line/branch/function coverage; 29/29 complete contract/move tests; 2/2 fresh
markerless-plan/native-oracle cases; and the malformed-plan and pending-witness
corpora, one test each. Actual published prepared/settled fixtures remain
unchanged. The unchanged published consumer runs under Node and Bun.

The complete contract/move run caught and fixed one additional dependency-rule
instance: remote-only metadata discovery must not load a PM registry when it has
no local values to compare. Its pre-fix function failed the unchanged copied
no-git CLI regression 1/1; changing only that projection restores 29/29 complete
file tests and 2/2 linked copied-CLI/alias checks.

On the implementation source, the public differential again passes 14/14
comparisons over 140 real items, with authoritative bytes unchanged. Typecheck,
build/test compilation, 114 documented declarations, production audit (zero
vulnerabilities), package dry run, changelog, publish-attestation/date checks,
strict tracker health, whitespace and public-path/privacy checks pass. The
health check has one advisory for pending telemetry; no telemetry setting was
changed. This package has no separate lint script.

Both local full release-gate attempts reported packed installer setup failures
before any of the eleven installation-shape scenarios ran, and were stopped
after the known failure. An isolated Node reproduction failed while installing
the public pm CLI tarball under the unchanged 180-second command limit (203.8
seconds total). These are incomplete full-gate results, not package coverage
approval. Test timeouts, assertions, and all four 100% package thresholds remain
unchanged. The packed test keeps its own empty cache; external cache priming was
stopped because it cannot change that hermetic setup.

The retained reference model has 512 sequences (seed `0x37a9c521`), 278
interruptions, 408 converged retries and 104 typed conflicts; the eight recording
server matrices cover 344 edit/crash cells over 172 boundaries. The native
normalization/replay model has 500 sequences (seed `0x5a17c0de`); create/PATCH
outcome seeds are `0x10262026` and `0x52621026`. Their last complete baseline
results are recorded in the earlier evidence above; latest complete-head
results await CI.

Implementation-source [CI](https://github.com/unbraind/pm-ado/actions/runs/40501684903)
and [CodeQL](https://github.com/unbraind/pm-ado/actions/runs/40501684938)
were queued when this receipt was written. The PR checks track the final
evidence commit too. Queued/skipped checks are not approval; no merge or release
was performed.


## Field-presence review

The refresh planner previously treated every scalar as present whenever a base
existed. New base writes persist an explicit `ado_base_fields` set; agreement,
merge, resolution and refresh readers share its decoder. Legacy partial bases
without this set hydrate all requested fields; complete legacy bases keep their
previous behavior. Per-key witnesses prevent a retained field from being reused
at another revision. These additional internal coordinates and conservative
hydration of unknown partial fields are intentional differences from the audit
baseline. See [sparse refresh](sparse-refresh.md) for the protocol and the package
item for exact-head test, revert and gate receipts.


The audit baseline predates `refresh-plan`, so its 14 comparisons retain the
original command surface. Refresh behavior is compared separately against the
pre-review `refreshSaved` build: at revision 3 with a legacy partial base holding
only a physical `relations` value, it schedules no hydration; the candidate
schedules `System.Title` and relation expansion, with both fields counted as
reads. This conservative hydration is intentional. The function-only revert
also fails the seeded and copied JSON/TOON cases (3/3); ordinary complete legacy
bases remain covered by the existing refresh suite.


[pm-ado-sdk-history-fence](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-sdk-history-fence.toon)
records the separate native SDK timestamp-match limitation discovered while
checking the new monotonic CAS rule. Under a fixed millisecond, two foreign
updates grow native history while preserving `updated_at`; the old match still
accepts a stale update. SDK `BulkItemUpdateMutation` currently exposes only
`match: BulkItemUniqueKey`, with no monotonic history-head precondition for its
native lifecycle operation. Public declaration and open-issue searches are
recorded in that follow-up for upstream ownership. No package-defined replacement
for SDK concurrency is introduced here.


### Presence-review verification receipt

Implementation head `f959f65` passes 20/20 refresh/agreement tests (both modules
at 100% lines/branches/functions), 22/22 earlier-review cases, 4/4 unchanged
consumer/normalization checks, and 14/14 public-tracker differential comparisons.
The 2,048-case presence property and 18 native SDK publications pass; four
function-only reverts fail 3/3, 2/2, 2/2 and 1/1 selected cases respectively.

Both isolated-home full release attempts hit the unchanged 900-second packed
fixture timeout. The npm attempt reports 907.8 seconds for that fixture, after
three launcher shapes passed; the Bun attempt reports 905.8 seconds, after all
six launcher shapes passed. Remaining global-runtime cases were interrupted or
could not start. The already-failed V8 runs were stopped before completing the
long crash matrix. Partial reporter counts are npm: 314 tests, 304 passed,
7 failed, 3 canceled; Bun: 360 tests, 353 passed, 4 failed, 3 canceled. These are
not complete suite counts, and package-wide coverage is not certified for this
head. All four 100% thresholds, test assertions and timeouts remain unchanged.
Current CI and handoff receipts are linked from the adoption item and PR.


## R7 monotonic-precondition audit

`node scripts/sdk-native-precondition-probe.ts` runs the package against the
real pinned SDK in a disposable non-git source copy, with no SDK mocks. It fixes
Date to the inspected timestamp and injects both ordinary concurrent edits and
ABA edits. Each case verifies that the SDK history length and last record hash
advance while `updated_at` stays equal. The command requires a typed conflict
and unchanged item state; it currently fails all 18 boundary cases (19 reported
failures including the parent), with no skips or cancellations. Output contains
only synthetic boundary receipts and counts; assertion stack paths are omitted.
This is an explicitly failing SDK acceptance probe, not a passing regression.
It is enforced after the ordinary release checks and by both Node CI jobs, so
a green ordinary suite cannot hide the unresolved native contract.

| Conditional-write family | Current implementation / outcome |
| --- | --- |
| Sync/import/export local prepare/replan, scalar/provenance, parent/dependency, close/assignment/recovery and agreement | All converge on `commitLocal`, whose native `commitItemMutations.match` compares `updated_at`; blocked on the native precondition |
| Standalone SDK relation import and compensation (`index.ts`) | Opaque native client updates have no history precondition; same SDK gap |
| Resolution agreement and replay publication | Same native timestamp match; same SDK gap |
| Resolution prepare | Locked document digest detects content changes, but needs a history-bound plan to reject ABA |
| Resolution settlement | Locked SDK callback also checks immutable last-prepare context; retain this ownership check |
| Refresh and other read-only previews | No local mutations or compare-and-set; do not claim an atomic multi-provider snapshot |

`mutateItemWithHistoryContext` exposes a locked callback and permits history
reads, but it cannot nest a native update/close under the same non-reentrant
item lease. The SDK's internal `runWithItemMutationPrecondition` is not public
and its validator is synchronous. Public `setActiveExtensionHooks` replaces
all active hooks; disabling extensions to install an isolated guard would
bypass existing policy and extension-owned runtime behavior. Hand-applying
native lifecycle or hierarchy changes would reimplement the SDK. The required
public contract is an expected history head (length plus record hash), or item
hash, on native lifecycle/bulk mutations; alternatively, an additive scoped
transactional guard that preserves the existing extension runtime. This remains
[pm-ado-sdk-history-fence](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-sdk-history-fence.toon),
linked to upstream #1576. No replacement or passing revert proof is claimed for
this unresolved class.

The previous head's CI completed after the earlier handoff: all four V8 jobs
passed 712 tests, zero failures/skips/cancellations, and 100% lines/functions,
but failed the unchanged 100% branch gate at 99.36%. Statement instrumentation
did not run. Added native schema-race, missing-provenance, unlinked-record,
lookup/budget and scope cases cover the gaps. Move scope normalization is shared
between selected and duplicate records; an impossible empty result from splitting
an already validated nonempty string and an unreachable uncertified-ID fallback
were removed without changing supported tracker behavior. Current gate receipts
are recorded on the adoption item and PR.

## R8 native history verification and compensation

`history-fence.ts` is the one native write verifier. `capture` records the
native length/hash before item inspection; `update` carries only its own
verified history head between writes. A native SDK write has an immutable
message binding its operation id to that witness. The SDK workspace journal
key also includes the witness and the SDK-derived digest of the native payload, so fixed-clock retries cannot accidentally
adopt an older committed journal or a different payload at the same inspected head. Verification checks the actual author,
native lifecycle operation and record's immutable patch against that chain.
It requires exactly the one own entry after the captured head.

If a peer intervened, `mutateItemWithHistoryContext` reads history and restores
only fields in this write's patch from SDK replay immediately before the own
write. Later scalar values are preserved. For tags and dependencies, later peer set additions/removals are applied to the state before the stale write, removing owned stale entries while retaining peer changes on both sides of the write. Both the write and the
verification/compensation stay in native history; no event is removed or
rewritten. The conflict result is durable in the verification event. Native
writes and verification run before the workspace step commits. Recovery
recognizes an unverified native marker, skips redispatch and completes the
same SDK journal before any fresh inspection. A crash before dispatch has no
native effect. A crash after verification reuses the immutable receipt.

Call sites: sync prepare/replan, scalar/provenance/link/graph writes, close,
assignment/recovery and agreement publication; resolution agreement
publication; standalone native-client relation import and compensation.
Opaque adapters retain their caller-owned `update` path (sync supplies the
same fenced writer). Native clients obtain their bound tracker from the
SDK's project `config(...).settings_path`, never ancestor or git discovery.
Resolution prepare/settlement already run under native item locks; new plans
include a length/hash head. Legacy version-2 plans still parse and use SDK
history replay to reject any native entry after the matching inspected
state, including no-op and ABA writes. Ambiguous legacy witnesses require a fresh plan. Refresh, contract and move previews are read-only.

The fixed-clock acceptance matrix uses real non-git trackers and a fake Azure
server: nine import/export write sites, each with ordinary and ABA edits.
Native unit/integration tests also cover dispatch interruption, recovery,
later peer title/body preservation, omitted field restoration, source/built
standalone relation writes, and portable/legacy plan refusal. Temporary
visibility of the write before verification is inherent in this approved
fallback; a successful command never treats an intervening native entry as
its own. Upstream #1576 would allow refusing before the lifecycle write.

### Equivalent native updates and SDK errors

The SDK omits a history event when an update is semantically unchanged. The
close pipeline can legitimately reach that case for its scalar step. After a
successful native call with no own event, the package records a zero-value
SDK audit witness under the item lock, checking the captured length/hash in
that same callback. A peer audit on either side of the no-op still refuses.
The ordinary verifier then validates this own witness exactly like a changed
native update. This adds audit evidence without reimplementing field writes.

If native execution throws, the package first looks for the exact own marker.
An owned partial effect is verified and selectively compensated; a refusal
without an own effect is classified as a conflict when a peer advanced the
head. A stable-head SDK refusal preserves its original cause. Verification
and compensation wait for live peer leases; they do not force those leases
away. Forward lifecycle actions retain their normal SDK permission checks.

## R9 creation receipts and immutable birth witnesses

Newly imported native items receive their scalar fields before their relations.
An ordinary `capture` after creation could accept a peer's intervening parent,
dependency or scalar edit as the integration's own baseline. Later relation
import could then overwrite it before returning a conflict.

`NativeWriteFence.captureCreated` instead reads the immutable first SDK create
event, uses SDK replay and value equality to verify its complete metadata
against the returned create receipt, and binds the witness to that event's
length and hash. Any later native entry refuses before further local writes,
including a same-millisecond ABA or a zero-value audit. Unsealed legacy birth
records use the SDK's record hash function. Existing-item capture remains for
fresh plans whose actual document reads occur after capture. The package's one
native create-to-follow-up path, shared by import and sync, uses the new method.
Standalone relation planning, resolution read-back and core Plan creation were
checked for the same rule; none reuses a stale native create receipt.

The fixed-clock integration property covers source and built import/sync with
seven peer-edit families: parent, parent ABA, dependency, scalar fields,
body/comments, mixed edits and audit-only history. It checks parent B explicitly
and compares all authoritative item and history bytes after the refusal.
Uncontended creation still imports parent A, and actual no-git JSON/TOON CLI
replay leaves those bytes unchanged. The native property also generates 32
nonempty peer field sets with seed `0x6b17cafe`; valid native creator, lifecycle,
parent, tag/body and context receipts remain accepted.

Reverting only the birth-capture function to ordinary late capture in a
disposable copy, then rebuilding, fails all 28 integration cases (29 reported
failures including the parent): eight explicit parent-B failures and twenty
other Azure-parent-A overwrite failures. The fixed integration/CLI suite passes
32/32. Only the current additive declaration snapshot changes; the released
consumer and its declaration fixtures remain unchanged.

## Escalated review: workspace transaction isolation prerequisite

The requested replacement imports `commitWorkspaceTransaction` from the broad
`@unbrained/pm-cli/sdk` entry. Its public declaration promises ordered steps under
one workspace writer lock, and `inspect()` and `apply()` do execute under that
lock. However, its `sdk-workspace-transaction` lock is acquired by transaction
callers and workspace snapshot operations, not ordinary native SDK lifecycle
updates. Those writers use item/hierarchy locks. Holding a workspace transaction
does not prevent a second process from changing the current item between its
inspection and application. Re-reading inside `inspect()` alone therefore does
not make the later write conditional.

Run the standalone capability diagnostic with the pinned SDK:

```sh
node test/helpers/workspace-lock-probe.ts
```

It creates a real tracker outside git, starts a second OS process for each
native `sdk.update`, and waits for that process to commit while the parent still
holds the workspace transaction lock. Every transaction uses a unique
`${item}-${randomUUID()}` identity and reads current state inside `inspect()`.
The diagnostic exits **4** when the advertised isolation is unavailable. It is
not a passing acceptance test and is not added to the release test suite.

| Peer edit after locked inspection | Subsequent transaction write | Observed result |
| --- | --- | --- |
| Title becomes `Peer` | Set title to `Azure` | Peer title lost; transaction `committed` |
| Assign parent B | Assign parent A | Parent B lost; transaction `committed` |
| Add a related dependency | Clear dependencies | Peer dependency lost; transaction `committed` |
| Assign `peer-agent` | Assign `azure-agent` | Peer assignment lost; transaction `committed` |

All **4/4** cases reproduce with installed SDK `2026.10.25`. The same standalone
probe run against an isolated copy of the published `2026.10.28` package also
reproduces **4/4** violations; no repository dependency was changed. Public
transaction, item-mutation and history declarations and open upstream issues
were checked. There is no expected native history-head/hash precondition in the
installed lifecycle API. A true item compare-and-set is tracked by
[pm-cli#1576](https://github.com/unbraind/pm-cli/issues/1576).

The required SDK contract is either a workspace critical section joined by
**all** native writers, with reentrancy for writes made inside it, or an expected
item revision/hash checked under the native item lock. Merely adding more
current-state reads leaves the same race before the next native write.

No production fence, history proof or compensation code was removed in this
assessment. The requested lock-removal revert proof and sync/crash acceptance
matrix cannot establish safety until the underlying SDK isolation exists.
There is **zero** production line delta in this escalation; it documents a
blocking prerequisite rather than claiming a completed repair.
