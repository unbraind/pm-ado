# SDK adoption evidence

The package uses SDK settings and type-folder registries to locate authoritative
items, and SDK lifecycle mutations for native writes. Automatic pm-side
compensation has been removed from native persistence and relation import.

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
| Unguarded persistence after a local snapshot | SDK lifecycle update with current-field and native-history detection | Fixed-clock pre-dispatch ordinary/ABA and birth witnesses remain; field evidence names saved/current state |
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

`ado_sync_intent` is advisory progress, not authority to overwrite a peer. Every
fresh invocation retires mutable version-1/version-2 intent data with the history
message `Discard obsolete Azure sync intent; replan current state`. New version-2 checkpoints hold only an opaque scope, unique plan coordinate,
observed Azure revision and optional diagnostic stage; saved desired values and
intent proofs are gone. Native SDK history remembers unacknowledged integration
effects and any later peer edit per field, independently of the retired intent.
Fresh Azure reads finish an interrupted native close assignment before export;
agreement still advances last and per key only after matching current local/Azure
read-back. Stored native observations refuse older Azure snapshots without using
mutable intent values as authority.

## Known limitations and measured window

A read and a native write are separate operations. Expected-item-hash/history
CAS is upstream [pm-cli#1576](https://github.com/unbraind/pm-cli/issues/1576).
The workspace transaction primitive serializes only cooperating transaction
callers, not ordinary native writers:
[pm-cli#1620](https://github.com/unbraind/pm-cli/issues/1620). A writer in the
remaining window may be overwritten; detecting it later never authorizes a
rollback. This policy explicitly makes no cross-process isolation claim.

`NativeWriteFence.lastWriteWindowMs` measures the interval from the final
revision read to SDK dispatch completing. It bounds when that call's native
write occurred; it is not a guaranteed maximum for later runs. The real SDK
measurement test prints twelve sample bounds. README Concurrency records a
sample and the exact guarantee: no rollback overwrites a peer, no rollback
creates cycles, no obsolete-intent manual-repair states.

The standalone SDK capability diagnostic
`node test/helpers/workspace-lock-probe.ts` remains outside acceptance. On SDK
2026.10.25 and 2026.10.28 it reports four isolation violations (exit 4), confirming
the upstream gap; this is not interpreted as a passing isolation test.

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
