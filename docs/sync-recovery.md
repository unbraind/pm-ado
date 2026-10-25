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

A terminal import has two **separately conditional** SDK commits:

1. A scalar update without lifecycle options, matched to the inspected revision.
2. A status-only update, matched to the revision returned by the scalar commit.

The second SDK update routes directly to the native close mutation. There is no
unguarded close step. If another agent changes status, body, comments or other
metadata between commits, the second commit refuses with `ADO_CONFLICT` and
keeps that newer document intact. Earlier committed scalar changes can remain;
this is a sequence of conditional commits, not an all-or-nothing distributed
transaction. A fresh explicit import uses a fresh inspected revision.

The same guarded update callback is passed to relation import and its parent
compensations. Initial local creation uses the SDK's atomic create; every later
write to that new identity matches the revision returned by create. A crash
never authorizes reusing a stale local revision.

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
is stable for that scoped local identity even if the local item changes later;
retry never silently replaces the original plan/key. The SDK atomic writer
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
proven historical result in revision order. The latest proven result supplies
the accepted base while its original local projection distinguishes subsequent
local edits. This also recovers repeated local conflicts across several PATCHes
without mistaking the adapter's own earlier effects for competing remote edits. Provider API references: [create](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/create?view=azure-devops-rest-7.1)
and [revision lookup](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/revisions/get?view=azure-devops-rest-7.1).

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

`test/sync.test.ts` exercises five scenarios: terminal import, fresh export,
relation/scalar export, pending-export recovery and mixed sync. A recording REST
server keeps object revisions and actual call counts. Tests enumerate before and
after every REST call, SDK local commit and outbox write observed in each path.
They either edit the real tracker or kill a real SDK worker process with
`SIGKILL`, then retry. Assertions cover unique remote objects, unique local
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

## Review repair verification

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
