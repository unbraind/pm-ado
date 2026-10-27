# Conditional sync publication and Azure recovery

PR [46](https://github.com/unbraind/pm-ado/pull/46) repairs two review classes:
local mutation sequences and non-idempotent remote creation. All tracker writes
continue to use the pinned pm SDK; no SDK lifecycle logic is copied here.

## Local conditional commits

Each item starts with the `updated_at` revision from the complete plan snapshot.
Every scalar, provenance, parent/dependency, annotation or compensating adapter
update uses `commitItemMutations` with an update `match` on that revision.
Expected revisions advance only from this command's immutable history markers.
Native no-ops retain the prior expected revision.

Before an item's first local effect, a matched SDK update records its scoped
`ado_sync_intent`: the inspected revision, plan digest and requested local values.
All following native SDK commits carry that plan's history marker and the
preceding returned revision. Requested values are recovery intent, never base.

A terminal import prepares its close coordinate in that intent, performs a
matched status-only native close, then finishes the requested mapped assignment.
A restart proves the native close from SDK history before restoring assignment;
it never exports the SDK's temporary unassignment as a new local edit.

Recovery inspects the latest history writer for each synced key. Foreign edits
remain edits even if they reverted to the old base value; ordinary sync reports
a typed conflict when they differ from Azure. Body/comment changes remain intact.
A native normalization that cannot represent the requested scalar also remains
a conflict; it is not exported as a user decision. Explicit import/export and
reviewed resolution choices remain deliberate direction decisions.

Only `advanceSyncBase` can publish agreed values. Full agreement clears the local
intent in the **same conditional commit** as the base/revision. A crash therefore
cannot discard local ownership proof before acknowledgement is durable. Partial
agreement retains the intent. Scalar, close and relation work always precede
read-back publication; initial creates omit the base.

Each close and publication step is guarded. If another agent changes status,
body, comments or other metadata between commits, the next commit refuses with `ADO_CONFLICT` and
keeps that newer document intact. Earlier committed scalar changes can remain;
this is a sequence of conditional commits, not an all-or-nothing distributed
transaction. A fresh explicit import uses a fresh inspected revision.

The same guarded update callback is passed to relation import and its parent
compensations. Initial local creation uses the SDK's atomic create; every later
write to that new identity matches the revision returned by create. A crash
never authorizes reusing a stale local revision.

## Agreed base: one read-back rule

`advanceSyncBase` in `agreement.ts` is the only rule for advancing any synced
scalar or relation base. Its callers are the final publication in
`runSyncCommand` (import, export, creation, ordinary sync and outbox recovery)
and `AdoResolutionService.apply` (including receipt replay).

The function reads the actual SDK item and its complete local graph after
mutations, then performs a fresh expanded Azure read. For each canonical key,
matching values can advance the base; disagreement retains that key's previous
witnessed value, or remains unknown in a versioned partial base. Relation sets
advance only when their complete canonical memberships match, so no added,
removed or retargeted relation is acknowledged speculatively. Historical base
values remain legitimate common ancestors while new edits diverge.

Publication matches the actual local read revision. Azure revisions cannot
move backward or precede the completed operation. `ado_rev` advances only when
all synced keys agree. The base also stores internal `ado_agreed_revisions`
coordinates for each witnessed key. A witnessed revision newer than an outbox
request retires that request's proof for that key, even if another key still
prevents advancing the item's acknowledged revision. A command with read-back differences returns
`ADO_CONFLICT`, even when earlier effects succeeded. Requests, plans, cached
responses and snapshots containing unimported remote changes never certify a
base value. SDK normalization that leaves the stores different is therefore an
explicit conflict rather than a false success.

Recovery proof is separate: `mergeSyncValues` may recognize **only scalar keys
actually written by the owned request**, comparing its original and accepted
values. Unrelated accepted fields and relations never become a common base.
An interrupted scalar PATCH with an unimported remote link therefore imports
the link on resume; it cannot reinterpret that link as a local deletion.

## Private outbox and idempotency coordinates

The package retains private intents under
`.agents/pm/transactions/pm-ado-sync/`, already excluded from git. Directories
use mode 0700 and records use mode 0600. SDK leases serialize each scoped
operation; only the short atomic journal writes run inside lease fencing.

An intent records the original request, canonical local values, scope, operation,
state and successful response. The key is:

```text
<pm item id>:<create or patch>:<canonical original plan digest>
```

The scope digest binds the configured organization and project. A create pointer
is stable for that scoped local identity even if the local item changes later.
An undispatched or durably rejected request may be replaced by corrected input and a new
plan/key; an unknown or successful request retains its original identity. The SDK atomic writer
persists the intent before the first side effect and records dispatch before POST.
Do not delete an intent to bypass a recovery refusal.

Creation stamps `System.Tags` with
`pm-ado-idempotency-<digest of scope and key>`. Before considering POST, the adapter
queries WIQL for that exact marker in the configured project, checks the returned
object and refuses ambiguous matches. A known durable identity remains
recoverable if the current marker was removed; a deleted/unavailable recorded
object does not authorize a replacement POST. Reserved protocol tags are excluded
from pm tag projections and preserved by subsequent tag updates.

A failed local link keeps the remote identity in the outbox. Export retry looks
it up and links the newly inspected local item rather than creating again.
Import/sync also consult pending ownership **before pairing identities**, so an
object exported by this tracker cannot be imported as a second local item.
Creation snapshots preserve accepted server defaults; a lost response can be
reconstructed from revision 1. Recovery compares the original local values,
accepted creation snapshot and current values before reconciling mapped edits.
Competing local/remote edits require an explicit decision.

PATCH intents cover scalar, relation and generated history-comment effects.
Every PATCH asserts the observed `/rev` and stamps `System.History` with its key.
Exact replay cannot append the same link/comment twice: either the old revision
still matches, or the adapter reads the expected resulting revision and proves
its operation marker. It returns that proven historical snapshot rather than
adopting a later writer's current document. Historical reads request expanded
relations. Before three-way planning, recovery reads each pending PATCH's
proven historical result in revision order. Every proven result is retained, and the latest proof is selected independently
for each scalar key actually sent;
its original local projection distinguishes subsequent local edits. Neither the
accepted snapshot nor its unimported relations become the common base. This also recovers repeated local conflicts across several PATCHes
without mistaking the adapter's own earlier effects for competing remote edits. Provider API references: [create](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/create?view=azure-devops-rest-7.1)
and [revision lookup](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/revisions/get?view=azure-devops-rest-7.1).

## Total outbox outcome state machine

`sync-outbox.ts` owns `OUTBOX_TRANSITIONS`, error classification, dispatch,
success recording, rejection recording and corrected-plan replacement.
`AdoHttpError` preserves HTTP status facts without changing command receipts.
The four durable states mean:

| State | Durable knowledge | Permitted recovery |
| --- | --- | --- |
| `prepared` | Original plan exists; dispatch has not been recorded | Use the latest input while no dispatch is recorded, then persist `dispatched` before the call |
| `dispatched` | Request might have reached Azure; outcome unproved | Lookup original key; create never blindly resends; PATCH may replay only the same revision assertion |
| `observed` | Exact accepted response or provider history proves the effect | Reuse identity/result; no new create or repeated link/comment |
| `rejected` | Atomic request definitively refused; no effect from that request is assumed | Replan corrected input under the same lease, persist `prepared`, then dispatch |

| Event / remote outcome | Transition and action |
| --- | --- |
| First plan / changed undispatched plan / corrected rejected plan | Persist `prepared`; corrected create replaces type, fields, local projection and key together |
| About to call create or PATCH | Persist `dispatched` before the call |
| Valid 2xx response | Persist response and `observed` |
| Definitive 4xx except HTTP 408 | Persist `rejected`; return the original typed HTTP error; corrected input can retry |
| Revision assertion refusal / proven foreign next revision | Persist `rejected`; return typed revision conflict; inspect a fresh revision before a corrected plan |
| HTTP 408, 5xx, other non-success statuses, invalid JSON, timeout or network failure | Retain/persist `dispatched`; resolve original key or exact historical PATCH result before another effect |
| Marker lookup proves original create / history proves original PATCH | Persist exact accepted snapshot and `observed`; finish local linking/publication conditionally |
| Create key is not visible after unknown dispatch | Remain `dispatched`; typed conflict, no second POST |
| PATCH has no accepted effect and asserted revision is unchanged | Same CAS request may safely retry; at most one link/history effect can commit |
| Crash before durable dispatch | `prepared`; safe to resume that plan |
| Crash after dispatch, including after a response but before recording it | `dispatched`; reconcile remote proof first, even if the lost response was a rejection |
| Crash after durable success / rejection | `observed` reuses proof; `rejected` permits corrected retry |

The complete table maps each of the five events (`dispatch`, `success`,
`rejection`, `ambiguity`, `retry`) for every durable state. Existing successful
proof is absorbing: a later error cannot downgrade `observed`. Only `prepared` (never dispatched) or `rejected`
plans invoke the corrected-plan transition; an ordinary retry cannot overwrite
unknown dispatch. Lookup/read failures never authorize an effect.

A rejection whose response was lost in a crash is **unknown**, not evidence of
rejection. HTTP 408 is also unknown. These are held safely until provider proof
exists; the API limitation below still applies. The model does not pretend
that absent visibility proves an unsent create.

## Ambiguous create dispatch: unresolved provider constraint

The documented Work Item Create API exposes no server-enforced idempotency key
or unique-tag condition. A crash after dispatch is durably recorded but before
POST is known to have reached Azure cannot distinguish an unsent request from
an accepted request whose marker is not yet visible.

The adapter fails closed in that state: `ADO_CONFLICT`, no second POST, retain
the intent, and retry marker lookup later. It converges automatically once the
original object becomes visible. If the request was never sent, safe automatic
convergence cannot be guaranteed without an additional server-side uniqueness
contract or an explicit recovery decision. This limitation was raised with the
orchestrator; it is not treated as approval to resend. The tests explicitly
assert the held state before simulating delayed provider visibility.

## Fault acceptance

`test/sync.test.ts` exercises eight scenarios: terminal import, terminal export, fresh export,
relation/scalar export, pending-export recovery, mixed sync, a concurrent remote
link during scalar sync, and recovery of an interrupted scalar PATCH. A recording REST
server keeps object revisions and actual call counts. Tests enumerate before and
after every REST call, SDK local commit and outbox write observed in each path.
They either edit the real tracker or kill a real SDK worker process with
`SIGKILL`, then restart with ordinary three-way sync. Assertions cover the intended
settled field values on both sides, no transient reopening PATCH, unique remote objects, unique local
identities, completed links, and preserved body/comment edits. Ambiguous create
dispatch is asserted to hold without another POST; recovery resumes only after
the marker is visible. Additional fixed cases cover concurrent status changes,
edits during POST, new-item annotations, competing ownership, missing/corrupt
journals, lost responses and revision-marker replay. Workers run in plain
trackers with no git executable on PATH.

Behavioural revert evidence and exact gate results are recorded on
[pm-ado-sdk-adoption](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/chores/pm-ado-sdk-adoption.toon).
The SDK terminal-update limitation remains tracked by
[pm-ado-sdk-match-close-1025](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-sdk-match-close-1025.toon).

## Round-1 review repair verification

Repair commit `a735bd1` passed [CI](https://github.com/unbraind/pm-ado/actions/runs/40236418608)
with all four jobs successful: Node 22, Node 26, npm release gate and Bun release
gate. Every job ran 423/423 tests in both V8 and independent statement passes,
with zero failures/skips. Coverage is 1580/1580 statements and 100% lines,
branches and functions across all nine required sources. CodeQL passed too.

The matrix has 82 observed boundaries and 164 fault cells: 82 real edits and
82 real SIGKILL interruptions. Function-only reverts fail for conditional close,
creation recovery, PATCH replay, ownership pairing and accepted-base recovery;
all restored fixed cases pass. Final differential evidence remains 14/14
comparisons across 140 public items.

Completed local checks: full V8 pass 423/423 with 100% lines/branches/functions;
latest focused regressions 6/6 through pinned `pm test`; restored revert cases
11/11; typecheck, 92 documented declarations and whitespace/privacy/history
checks pass. Duplicate local full release runs were interrupted after the
requested complete CI gates passed; those interrupted runs are not counted as
successful release checks. There is no standalone lint script.

## Round-2 semantic and model verification

The two fixed cases reproduce SIGKILL after scalar import and HTTP 400 followed
by corrected export. The crash case restarts with ordinary `ado sync`, asserts
both sides stay closed, and rejects every transient reopening PATCH.

The seeded fake-server model drives 36 create and 33 PATCH sequences through
HTTP refusal, success, HTTP 408/5xx/redirect, connection loss before/after effects,
malformed success bodies, and interrupted journal/response boundaries. It also
changes rejected fields and type. It checks durable state, stable identity,
new corrected-plan keys, exactly one accepted remote object or revision/link,
and replay without another effect. Unknown create outcomes explicitly hold with
no second POST until the model supplies provider visibility. Convergence is
conditional on that proof; an actually unsent ambiguous POST remains the
provider-contract limitation above.

The rejection crash checks kill a real worker immediately after the HTTP 400
call and before/after the `rejected` journal write. A durable rejection permits
corrected input and one accepted creation. A rejection response lost before
its journal write is correctly unknown: repeated sync sends no additional POST.
That held case is reported separately, rather than counted as unconditional
convergence.

Current local round-2 evidence: 196 semantic fault cells across six scenarios;
83 non-matrix tests with 100% lines/branches/functions in both sync modules;
18 restored focused tests; 14/14 public-corpus differential comparisons; and
three function-only reverts each failing 1/1. Full statement and package-wide
coverage evidence comes from the round-2 npm/Bun CI gates linked by the PR.

Round-2 repair `4c29583`, with current main incorporated at `9fe7628`, passed
[CI](https://github.com/unbraind/pm-ado/actions/runs/40266894633): all four jobs,
469/469 tests in both coverage passes per job, zero failures/skips. Statements
are 1607/1607; statements, lines, branches and functions are all 100% across
nine required sources. [CodeQL](https://github.com/unbraind/pm-ado/actions/runs/40266894638)
passed. The final pinned PM linked run passes all 18 focused tests.

## SDK module dependency

Guarded writes use the installed SDK module for conditional mutations, immutable
history and durable journals. Keep the SDK link supplied by `pm install`.
Manually removing that link now yields `ADO_USAGE` naming the missing dependency;
bound read-only refresh remains available. No launcher path is inferred and no
local mutation substitute is used. The pinned host facade lacks these module
primitives; [pm-ado-host-sdk-facade](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-host-sdk-facade.toon)
records the declaration search and upstream follow-up for the orchestrator.


## Round-3 review repair verification

`advanceSyncBase` is the sole advancement rule, with conditional publication in
`runSyncCommand` and `AdoResolutionService.apply` (including replay). The final
source checkpoint `0ac2505` passed 663/663 behavioral tests in Node 26 CI, with
zero failures or skips. Its coverage gate correctly refused the remaining
branches; focused acceptance cases and the subsequent complete release gates
are linked from the PR checks, rather than treating that checkpoint as a pass.

The independent two-sided reference model passed 512 sequences with seed
`0x37a9c521`: 278 interruptions, 408 converged retries and 104 typed conflicts.
Both actors add, change and clear scalars; add, remove and retarget relations;
and close and reopen items. It interrupts import, export, sync and recovery,
resumes, and applies further edits. Every successful sync leaves the synced
keys equal; every new base coordinate has an actual equal read-back witness.
The inherited normalization model additionally runs 500 sequences, 500 exact
replays and 50 older-revision replay refusals.

The eight deterministic recording-server matrices pass 344 semantic fault
cells across 172 observed before/after boundaries: 36 terminal-import,
28 terminal-export, 44 fresh-export, 52 relation-export, 52 pending-export,
64 mixed-sync, 40 concurrent-link and 28 pending-PATCH cells. Each boundary
receives a real local edit and a separate process `SIGKILL`. Assertions check
no duplicate objects, links or generated comments, no lost edits, preserved
intended states, ordinary-sync recovery, and the documented held-create case.

Five separate function-only reverts each fail their focused acceptance case:
accepted-snapshot promotion loses the model's remote link; premature proof
retirement bypasses a conflict; retaining only the last request loses creation
default evidence; ignoring foreign local reversion overwrites an edit; and
skipping proven native assignment recovery prevents convergence. Restoring
all five passes the same five cases. Receipts are recorded on the adoption
item. The public-tracker differential remains 14/14 over 140 real items.


Additional focused cases cover empty-assignment close recovery, per-key revision
fencing without `ado_rev`, removal of a server-default relation during explicit
creation export, and a pending inverse endpoint that has not yet been read back
on Azure. The last case refuses sync without a PATCH or tracker mutation, then
converges after the matching remote inverse is observed. These use real SDK
trackers; expected native behavior is not hand-written into the fixture.


## Verified review-repair source gates

Source checkpoint `d11f1f2e00d3a1f1e63dc8b7ab68a36f17830660` passes
[all four CI jobs](https://github.com/unbraind/pm-ado/actions/runs/40447305631):
Node 22, Node 26, the complete npm release gate and the complete Bun release
gate. Each passes 667/667 tests twice, with zero failures or skips. All eleven
required sources have 100% statements, lines, branches and functions;
statements are 1955/1955. Real packed install-shape acceptance passes on CI.
[CodeQL](https://github.com/unbraind/pm-ado/actions/runs/40447305694) also passes.

The exact source passes 14/14 public-corpus differential comparisons across
140 real items, alongside 5 fixed, 6 agreement and 4 added acceptance cases
through the pinned pm test runner. Typecheck, test typecheck, build, 111/111
documented declarations, changelog, whitespace, append-only history and public
evidence privacy checks pass. Strict local tracker health passes with its
pre-existing queued-telemetry advisory. No standalone lint script is configured.
Local packed setup encountered a reproduced registry timeout; CI supplies the
successful full npm/Bun acceptance evidence rather than counting that local
attempt as a pass.

Both audited SDK findings are replaced, none deferred. Seven original
implementation lines are removed; the full change deletes 47 core lines
relative to current main. The two SDK follow-ups and ambiguous-create provider
constraint above remain explicit. The adoption item is left in progress and
its claim released for orchestrator verification. The final tracker/docs-only
commit is checked again through [PR checks](https://github.com/unbraind/pm-ado/pull/46/checks).
No merge or release is performed.


## Endpoint closure and unknown ancestry (auto round 1)

Selection limits and WIQL filters choose remote sources, not permission to
replace another local item's graph. `planRelationImport` is the shared read-only
planner used by import execution and sync preflight. It enumerates every native
parent/dependency update, including an inverse child outside the selection.
Prospective source identities allow preflight before native item creation;
mutation always replans after real SDK identities exist.

Ordinary sync checks every affected endpoint's durable recovery history and its
own agreed relation base. A foreign relation edit, or a local graph different
from that endpoint's witnessed ancestor, returns `ADO_CONFLICT` before effects.
An unknown endpoint base requires an explicit direction rather than an inferred
winner. Owned partial integration writes retain their SDK history proof. The
same guard runs at every native graph update and compensation; revision matches
continue to refuse edits arriving after the snapshot. Explicit import/export
retain their documented direction choice. Dry-run uses the same endpoint check.

Resolution treats unknown ancestry per key: `ResolutionField.base` is `null` for
an absent key in either a partial or legacy base. It never hashes `undefined`
and never substitutes an empty value. JSON, TOON, saved core Plans, portable
artifacts, prepare validation, apply and replay share `resolutionFields`.

Acceptance includes clear/retarget/dependency edits in both hierarchy directions,
unselected fully agreed endpoints without an intent, prospective new sources,
a positive control excluding prospective IDs from native persistence, and all
512 known/unknown masks across scalars and relations. The first-import remote
title race produces a valid partial base, JSON/TOON choices, a saved Plan and a
successful reviewed apply/replay. Real packed npm/Bun launcher shapes exercise
partial resolution and unselected endpoint conflicts in non-git trackers.

Function-only reverts reproduce both classes: removing the endpoint guard fails
9/12 graph cases and reinstates cleared/retargeted parents; restoring the old
partial-base digest rule fails 2/2 resolution cases. Restored focused cases and
full gate results are recorded on the adoption item. No existing tests were
removed or weakened.


Packed acceptance additionally distinguishes project and global runtime scopes.
Project-installed managed SDK links remain intact; the SDK's non-regular-storage
preview refusal is reported as actionable `configuration` before preparation or
Azure writes. The public `previewItemMutations` signature has no runtime exclusion
option. No adapter clone or regular-file bypass replaces that SDK guard.
[pm-ado-sdk-preview-runtime](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-sdk-preview-runtime.toon)
records the declaration search, empty upstream issue searches and missing
SDK capability for the orchestrator. Global runtime outside the selected tracker
passes complete partial-base apply and endpoint-conflict acceptance through all
five linked launcher shapes. Already-closed unassigned items can apply reviewed
scalar choices without repeating closure or replacing existing close evidence.

Status mappings and recovered intent status coordinates pass through the SDK's
`resolveRuntimeStatusRegistry` and `normalizeStatusForRegistry` before native
lifecycle dispatch. Case aliases therefore use the same close behavior and
preserve the same terminal evidence as canonical names, including after resume.
Resolution normalizes only native lifecycle values; portable plan digests retain
their original coordinates. An already closed item is previewed without another
close request, preserving its original close reason and timestamps.

## Verified auto-round-1 source

Source `f7f89e9` passes [CI](https://github.com/unbraind/pm-ado/actions/runs/40467343302)
4/4 jobs: Node 22, Node 26, complete npm release gate and complete Bun release
gate. Each passes 696/696 tests in both coverage runs, with no failures or skips.
All eleven required sources have 100% statements, lines, branches and functions;
statements are 1997/1997. [CodeQL](https://github.com/unbraind/pm-ado/actions/runs/40467343299)
also passes. The model again reports 512 sequences, 278 interruptions, 408
converged retries and 104 typed conflicts with seed `0x37a9c521`.

The 24/24 PM-linked regressions and 14/14 public differential comparisons over
140 items pass locally. Function-only reverts reproduce endpoint overwrite,
missing-base hashing, alias lifecycle and terminal-preview failures. Local full
release attempts were incomplete: npm reached the packed parent timeout after
eight successful launchers; Bun failed in installer setup before its first
launcher. Neither local attempt is represented as a complete pass. Dedicated
CI passes real packed acceptance through all twelve parent/child cases.

Current main is `64aca03`, incorporated at `4d590fd`. That merge only
adds Hound configuration and its unrelated tracker item, preserving the measured
sync implementation and test assertions. The final evidence commit releases the
adoption claim without closing items; its exact-head checks are linked from
the [PR checks](https://github.com/unbraind/pm-ado/pull/46/checks).
