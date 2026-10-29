# Conditional sync publication and Azure recovery

PR [46](https://github.com/unbraind/pm-ado/pull/46) repairs two review classes:
local mutation sequences and non-idempotent remote creation. All tracker writes
continue to use the pinned pm SDK; no SDK lifecycle logic is copied here.

## Forward-only local writes

`NativeWriteFence` reads current SDK-normalized fields before each lifecycle
write and compares them with the saved snapshot. Native history also detects
observed ABA edits and protects read-back publication. A detected change returns
a typed `sync_conflict` with item, fields, base and current values inside the
existing `ADO_CONFLICT` envelope. Processing stops before dependent work.
Already completed changes remain durable; no parent, scalar, body, intent or
collection value is restored automatically. SDK hierarchy/permission validation
runs on every forward write.

Local `ado_sync_intent` is advisory recovery metadata. Every fresh invocation
retires mutable old/new intent data through an SDK update whose immutable
message records `Discard obsolete Azure sync intent; replan current state`.
The next plan uses current pm and Azure reads. Version-2 checkpoints retain
observed remote revisions and diagnostic stages, with no saved desired fields or
history-proof requirement. Native history tracks unacknowledged integration
changes and later peer edits per field, so discarding an intent cannot forget a
peer's clear or retarget. Immutable own observations reject stale Azure reads.
No abandoned compensation journal is replayed. A fresh remote read can finish a
native close assignment before export; the agreed base still advances last,
only from matching reads.

A final read and a native write are separate operations. Native CAS is missing
([#1576](https://github.com/unbraind/pm-cli/issues/1576)), and workspace
transactions do not isolate ordinary writers
([#1620](https://github.com/unbraind/pm-cli/issues/1620)). An edit in that window
can still be lost; detecting it afterwards never authorizes a reverse write.
See README Concurrency for the measured dispatch bound and precise test scope.

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

The recording fake Azure server and real SDK trackers cover every observed
REST, outbox and local boundary. Existing creation/export/import/close/recovery
matrices and the two-sided 512-sequence merge model remain in the suite. The
forward-only matrix adds real SIGKILL and a second CLI process that edits title,
parent, relation and assignee together at each selected boundary. A rerun must
proceed or return a field conflict, preserve the peer's final fields, retain an
acyclic hierarchy, and avoid duplicate native/Azure identities and relations.

Reviewer fixtures cover X moving A to B before a peer sets A.parent=X, and a
peer edit during close-intent preparation followed by legacy compensation
history. Restoring old metadata is forbidden even when reporting a conflict.
The cycle fixture keeps X.parent=B; stale intents are discarded and subsequent
import/export/sync never request manual intent repair.

These checks do not claim ordinary-writer isolation in the SDK gap. An edit
strictly between the final read and actual write can still be overwritten;
there is no compensation that could turn that limitation into a new graph or
recovery corruption. All existing immutable history remains readable.

## SDK module dependency

Guarded commands require the host's SDK module link created by `pm install`.
If it is missing, writes return a dependency refusal; read-only sparse refresh
still works. Current field presence and per-key read-back agreement rules are
shared by import, export, recovery, resolution and refresh planning.
