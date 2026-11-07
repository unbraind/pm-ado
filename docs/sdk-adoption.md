# SDK adoption evidence

The package uses SDK settings and type-folder registries to locate authoritative
items, and SDK lifecycle mutations for native writes. Automatic pm-side
compensation has been removed from native persistence and relation import.
The declared minimum SDK (2026.10.23) matches the peer dependency and manifest.
The development SDK supplies these acceptance primitives; feature-specific host
requirements are documented separately below.
Managed extension runtime links require a host SDK of at least 2026.10.27 for
semantic preview; this minimum is separate from the development pin.

Tracker items:
[pm-ado-sdk-adoption](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/chores/pm-ado-sdk-adoption.toon),
[pm-ado-sdk-history-fence](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-sdk-history-fence.toon).
Detailed earlier receipts and behavioral reverts remain in their append-only
comments/history and the PR commits.

The review-round lifecycle property in `test/history-fence.test.ts` exercises
source and committed output with assigned and unassigned native items. Each
case closes, reopens, cancels, activates and blocks the item, then verifies that
a peer's explicit assignment clear refuses a stale write without changing the
item or history. A native lifecycle call may append several owned events; the
fence must validate the complete suffix rather than assume one event per call.
The full sync suite also retains its 512-sequence two-sided preservation model,
including interrupted remote assignment clears. Test compilation checks that
ownership assertions use complete SDK metadata rather than a partial get
projection. These controls run in disposable trackers without git.

An explicit first import can initialize fields positively proven unchanged
since their native birth. Any later field patch, including an ABA change or
assignment clear, and any recorded agreement retire that permission. Unknown
legacy fields without birth proof still require a reviewed choice. The same
proof governs preview and apply, and graph initialization covers only selected
endpoints. Source/build adversarial tests exercise every mapped scalar, context
preservation, selected and indirect graph endpoints, and legacy missing history.

| Audit/review finding | SDK replacement or policy | Behavioral evidence |
| --- | --- | --- |
| Prefix-only authoritative lookup | `readSettings`, `resolveItemTypeRegistry`, `locateItem`, `readLocatedItem` | Custom nested folders and whole-document guards work without git; original function-only revert fails lookup regression |
| Unguarded persistence after a local snapshot | Decision-document hash bound to SDK `withExpectedItemRevisions`, plus current-field and native-history detection | Separate-process title/body/assignment/status/parent/dependency writes refuse before mutation; own lifecycle and retry controls pass |
| Compensation can restore a parent cycle | Forward-only SDK writes, no native restore or relation rollback | X stays under B after peer sets A.parent=X and edits X; graph remains acyclic |
| Own compensated intent becomes a permanent refusal | Obsolete intent discard through an SDK update with a recognized history reason | Old compensation records remain readable; import/export/sync replan rather than require manual repair |

## Forward-only write contract

`NativeWriteFence` captures SDK-normalized documents and native history before
planning. Before each update, it re-reads target fields and native history.
Observed peer edits stop the item and dependent work with `ADO_CONFLICT`,
`kind: sync_conflict`, and item/field/base/current evidence. No automatic reverse
mutation runs after success, SDK refusal, conflict, crash or restart. SDK parent
and permission validation remains active on every forward lifecycle operation.

A newly created local item binds to its exact SDK birth receipt, so post-create
peer edits cannot become an owned baseline. Portable resolution plans retain
native head coordinates; agreement publication is detection-only and never
rolls metadata back. The relation importer also retains completed forward
parents when a later endpoint fails.

`ado_sync_intent` is advisory progress, not authority to overwrite a peer. A non-preview invocation that passes scalar and relation preflight
retires mutable version-1/version-2 intent data with the history
message `Discard obsolete Azure sync intent; replan current state`. New version-2 checkpoints hold only an opaque scope, unique plan coordinate,
observed Azure revision and optional diagnostic stage; saved desired values and
intent proofs are gone. Native SDK history remembers unacknowledged integration
effects and any later peer edit per field, independently of the retired intent.
Fresh Azure reads finish an interrupted native close assignment before export;
agreement still advances last and per key only after matching current local/Azure
read-back. Stored native observations refuse older Azure snapshots without using
mutable intent values as authority.

## Revision guard and compatibility

`NativeWriteFence.update` passes `hashDocument` of its saved SDK-normalized
decision document to `withExpectedItemRevisions`. It never takes a later
revision read as the expectation: that could adopt an intervening peer edit.
The scope wraps the existing lifecycle dispatcher, retaining native policies,
hooks and multi-event transitions. SDK revision conflicts become the existing
`sync_conflict` receipt; an unchecked scope refuses. The same fence covers sync
checkpoints, mapped fields, close/assignment transitions, relation import and
agreement publication. Resolution prepare/settle already compare their decision
state within `mutateItemWithHistoryContext` and retain that sequencing.

Unchecked dispatches report that the revision check did not run, together with
read-back field differences, and retain the original baseline. When native close
validation fails after an owned field update, the original validation error is
preserved only if every added event is a prefix of the intended SDK mutation
plan and the current document matches native replay. Planning uses the bound
`PmClient.previewItemMutations` apply path, including native normalization and
its canonical intermediate field update before close. Successful operations
must match the complete planned event sequence; no-ops authorize no new event.
Every successful write also requires its unmodified native SDK update receipt,
so a peer cannot substitute the intended effect and turn the owned write into a
no-op. Older supported SDKs without record-bearing previews rely on this receipt: canonical returned metadata, actual changed-field names,
message markers and bounded native lifecycle record count. A copied message
cannot authorize an extra field/event or an edit beside an owned no-op. Missing
or altered adapter receipts refuse without advancing the baseline. Their failed
partial writes retain the previous forward-only history-conflict policy.
Only SDK-declared commit-time values are masked when comparing planned and
committed documents; field presence and immutable native heads remain checked.

Every supported SDK, including the declared minimum, provides session context.
Message markers and per-operation provenance are additional checks. An inherited
async context is descriptive attribution and cannot authorize an extra write,
even when an in-process peer copies the author and message. This applies to
ordinary fields, relations, audit-only events, ABA, and failed partial closes.
Native hooks and guards still run; unplanned effects cannot be silently adopted.
A failed diagnostic history/document read cannot replace the primary write
error. A positively identified native conflict, including a missing item, still
wins. Failed operations never advance the fence baseline; replan from durable
partial state. Azure PATCH diagnostic read failures likewise preserve the
original revision refusal and retain available diagnostic details as its cause.

The pinned 2026.11.4 SDK's `ExpectedItemRevision` accepts only `id` and
`itemHash`. It has no expected native-history coordinate; history reads remain
separate. The package therefore retains its monotonic head checks before and
after dispatch. ABA or history-only events in the final interval remain
detection-only. The new guard does not claim complete monotonic isolation,
workspace-wide serialization, or atomic Azure REST and local commits.

The peer/manifest floor remains 2026.10.23. Capability detection preserves the
older host's documented history-detection-only path. A real 2026.10.25 installed
SDK exercises that path, successful writes, native validation and stale refusal.
Source/built regressions on the development SDK use real no-git trackers and
independent OS-process peers across six field classes, plus legacy unjournalled
document edits and a dispatcher that never evaluates its guard. Legacy native
histories and no-op writes remain readable and usable.

Certification here is limited to filesystem storage without overrides. The
storage-override revision advancement corrections in
[pm-cli PR #1658](https://github.com/unbraind/pm-cli/pull/1658) postdate the
development pin. This change neither bumps that pin nor certifies transformed,
redirected or skipped writes on that artifact.

`NativeWriteFence.lastWriteWindowMs` measures the interval from the final
revision read to SDK dispatch completing. The real SDK measurement test prints
twelve sample bounds; a timing sample is not an atomicity proof. No rollback
overwrites a peer or creates cycles, and obsolete intents do not require manual
repair. The standalone `test/helpers/workspace-lock-probe.ts` diagnostic still
measures the separate coordinator lock, not the item revision guard; its historic
isolation violations are not passing acceptance evidence.

## Remaining backend roadmap

Issue #47 remains open. These Feature items carry the remaining acceptance work:

- [Backend authority and recovery contract](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/features/pm-ado-backend-contract.toon): replace path-bound reads, preview, settlement and durable intents; distinguish provider authority from projections; preserve Azure identity, revisions and crash recovery without holding database transactions across REST calls.
- [Locked monotonic audit coordinate](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/features/pm-ado-monotonic-write-guard.toon): refuse final-interval ABA/history-only writes before mutation; advance own lifecycle events; certify storage-override behavior on a corrected SDK artifact.
- [Filesystem/native database conformance](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/features/pm-ado-backend-conformance.toon): reuse failure-sensitive resolution fixtures on both backends without a local tracker for the database; cover competing writers, stale Azure revisions, replay, settlement, unsupported capabilities, authorization and typed relation fidelity using synthetic REST.

## Differential and compatibility proof

The differential harness builds origin/main and the candidate and runs SDK/CLI
operations on independent non-git copies of public fleet trackers. It compares
canonical values, command receipts and net native patches. Source trackers are
fingerprinted before/after to prove they were not changed.

Intentional differences are native forward audit markers/counts, canonical
resolution-plan witnesses and per-key agreement coordinates. Verification and
compensation events are no longer emitted. The current declaration snapshot is
reviewed explicitly; the prior published consumer and published declaration
fixtures remain unchanged and run with Node and Bun.

## Verification

Focused tests cover both reviewer fixtures, the stale-intent corpus, every new
crash/peer boundary, no-git source/built commands, and native field/hierarchy
validation. Existing outbox state-machine, two-sided merge, partial-base presence
and status-alias models remain. Revert proofs run only in disposable source
copies with the same pinned SDK; no historical tracker stream is rewritten.

Release gates retain all four 100% thresholds. CI results and exact source
heads are recorded in the PR and tracker comments; pending runs are not approval.
