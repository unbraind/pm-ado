# Revision-bound conflict decisions

`pm ado resolve-plan --item <id>` previews one linked item without changing
Azure or pm. It uses the existing sync field projections, three-way base and
state maps. Output contains eight field digest rows, a whole local-document
revision digest, Azure revision/snapshot digest, scope and state-map digest.
Field contents and credentials are absent. JSON and the default compact TOON
are rendered by the host. Requires pm CLI **2026.10.23+** for expired mutation
lease fencing; works in a plain, non-git tracker.

Every differing mapped field needs exactly one explicit `local` or `remote`
choice, including one-sided changes. Equal fields require no choice. Duplicate,
unknown, redundant, missing and invalid choices refuse before REST writes.
Plans bind all metadata and body changes, including a second writer's comments,
not only mapped values. Changing state maps also invalidates the plan. Digests
are concurrency coordinates, not signatures or authorization tokens: review the
artifact and run with your own authorized credentials.

## Example

```sh
pm ado resolve-plan --item example-123 --json > preview.json
# Extract .plan, review field digests against pm get / Azure, then add choices:
# "choices": [{"field":"title","take":"remote"}]
pm ado resolve-apply --artifact decision.json --json
```

For durable storage use `--save`. This creates an ordinary core **Plan** item,
with the portable artifact JSON in its body, and returns `plan_id`. Update that
body with reviewed choices using `pm update <plan-id> --body ...`, then run
`pm ado resolve-apply --plan <plan-id>`. No parallel plan store is created. The
apply command accepts exactly one of `--plan` and `--artifact`; artifact files
contain the plan itself, not the command's `{ok, plan}` envelope.

SDK consumers import `AdoResolutionService`, `ResolutionPlan`,
`ResolutionChoice`, `ResolutionReceipt` and `ResolutionRefusal` from `pm-ado`.
Construct the service with the tracker root, author, real `PmClient`, `AdoClient`
and `AdoConfig`; call `plan(id)`, fill `choices`, then `apply(plan)`. The service
uses certified complete SDK reads, authoritative item reads, core mutation
preview, and the audited mutation pipeline; there are no git subprocesses.

| Refusal code | Remedy |
| --- | --- |
| `invalid_plan` | Generate a complete, unedited version 1 artifact. |
| `invalid_choices` | Choose exactly once for each differing field. |
| `stale_local` / `stale_remote` | Generate a fresh plan and review new digests. |
| `scope` | Restore the original scope/maps and unique linked identity. |
| `configuration` | Supply credentials, item or plan selection and a supported host. |
| `apply_failed` | Check health/connectivity and inspect both sides before retrying. |

Apply holds the core per-item lease from the local revision check through the
Azure revision assertion and local audit commit. Stale plans change neither
item. Azure can still race after the pre-read; the existing `test /rev` PATCH
then refuses atomically. Successful decisions record a receipt on the target
item and in immutable history; replay returns `replayed: true` with
no extra PATCH or history event. Older applied decisions also replay using their immutable history receipts. The artifact is cloned before asynchronous
work so caller edits cannot change an in-flight decision.

This is scalar field resolution. Graph relations retain their dedicated sync
adapter and are never overwritten by a decision. Existing relation base values
are preserved for subsequent sync. A missing legacy base stays absent until
sync can establish agreement for both scalar fields and relations. No revisions-feed reconciliation is added.
Azure and pm are separate systems: a REST success followed by a lease expiry,
process interruption or local validation failure can leave Azure updated and pm
unchanged. Re-read both sides and make a fresh plan; never blindly retry onto a
new revision. Core lease fencing prevents committing stale local bytes after
another writer takes over. Fixture acceptance does not establish live Azure
permissions or custom organization process rules.


## Measured offline acceptance

Public `unbraind/pm-ado` tracker at
`1fe0a306e13417115e66de9b48ac2e50deaa25d1`, copied into a non-git scratch
directory: **28 certified items**, **224 field comparisons**, **28 synthetic
title conflicts**, **28 valid plans**, **28 omitted-choice refusals**. Plans
averaged **2,561 JSON bytes**. Fingerprints before/after confirmed copied source
files unchanged; SDK runtime caches are excluded. All overlays were in memory,
including an explicit `canceled` → `Removed` state map. Azure writes: **0**.

Reproduce with `node scripts/validate-resolution-corpus.ts "$PUBLIC_PM_COPY"`,
where the variable names an archived public tracker root outside a git repo.
The script reads real pm rows through `listAllComplete`; the Azure side uses the
[recorded REST 7.1 response fixture](../test/fixtures/resolutions/README.md).
Successful applies, revision races and actual CLI rendering are measured
separately on disposable real SDK trackers by `test/sync.test.ts`.
