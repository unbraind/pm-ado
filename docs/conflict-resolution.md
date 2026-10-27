# Revision-bound conflict decisions

`pm ado resolve-plan --item <id>` previews one linked item without changing
Azure or pm. It uses the existing sync field projections, three-way base and
state maps. Output contains eight field digest rows, a whole local-document
revision digest, Azure revision/snapshot digest, opaque scope reference and
state-map digest. Version 2 plans contain no configured organization URL or
project name. The scope reference is an HMAC over both values, keyed by the
locally configured token; the token and HMAC input are never stored in a Plan.
Keep local configuration stable until settlement; token rotation invalidates
unsettled artifacts. Version 1 artifacts are refused and must be regenerated.
Field contents and credentials are absent. JSON and the default compact TOON
are rendered by the host. Requires pm CLI **2026.10.23+** for expired mutation
lease fencing; works in a plain, non-git tracker.

Authoritative document lookup follows the tracker's configured item format and
type-to-folder registry, including custom types in nested folders. The revision
digest still covers the complete raw document read through the SDK, including
the body and annotations.

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
and `AdoConfig`; the documented five-argument call remains supported. An optional
public SDK namespace and observer can follow. Call `plan(id)`,
fill `choices`, then `apply(plan)`:

```ts
import * as sdk from "@unbrained/pm-cli/sdk";
import { AdoResolutionService } from "pm-ado";
// pm, azure and config are the caller's already-bound clients/configuration.
const service = new AdoResolutionService(pmRoot, author, pm, azure, config);
const explicit = new AdoResolutionService(pmRoot, author, pm, azure, config, sdk);
```

When the SDK argument is omitted, the service imports its installed public SDK
package. Explicit injection remains supported. No SDK is discovered from the launcher. Resolution commands are the
only command paths needing low-level history/mutation primitives beyond the
injected `ctx.sdk.client`. They load those lazily through the SDK link maintained
by `pm install`, using a canonical module file and standard Node resolution.
A missing link produces a typed `configuration` refusal with an installation
remedy. Invalid command selections do not acquire this runtime. The service
uses certified complete SDK reads, authoritative item reads, core mutation
preview, and the audited mutation pipeline; there are no git subprocesses.

| Refusal code | Remedy |
| --- | --- |
| `invalid_plan` | Generate a complete, unedited version 2 artifact. |
| `invalid_choices` | Choose exactly once for each differing field. |
| `stale_local` / `stale_remote` | Generate a fresh plan and review new digests. |
| `scope` | Restore the original scope/maps and unique linked identity. |
| `configuration` | Supply credentials, item or plan selection and a supported host. |
| `apply_failed` | No intent was prepared; check tracker health and configuration. |
| `ado_partial_apply` | Preserve the recorded intent; restore tracker write/lease access and retry the same plan or artifact. If either side moved, inspect the recorded PATCH and history before reconciling manually. |

Apply is a resumable two-phase operation using the core audited item mutation
pipeline and its fenced leases:

1. Validate all choices and both saved revisions, then durably commit
   `ado_resolution_intent` and a prepare history event on the target item. The
   intent contains the decision/plan ID, original local revision, remote
   revision/digest, exact JSON PATCH and expected post-PATCH Azure revision.
2. Recheck the prepared local state under a new item lease. Send the recorded
   PATCH with its leading `test /rev` and a unique `System.History` decision
   marker. Commit the local mapped values, settled history receipt and intent
   removal together through the fenced SDK mutation.

A lease takeover, filesystem write failure or lost response after PATCH leaves
an inspectable intent. Re-running the **same** `--plan` or `--artifact` checks
Azure's expected revision, unique marker and mapped outcome, then completes the
local settlement without another PATCH. If Azure still exactly matches the
recorded pre-PATCH snapshot, the saved revision-checked PATCH can be attempted.
A different revision, missing marker, changed result or competing local edit
refuses with `ado_partial_apply`; its remedy names the intent and expected
revision. Never clear an unresolved intent or replace it with a new plan to
bypass that refusal. Recovery data remains in the target item's metadata and
immutable history; portable core Plan bodies contain only digest coordinates.

Plans found stale before prepare make no item or Azure writes. An Azure race
after prepare atomically refuses the PATCH and leaves its audited intent for
inspection. Successful replay returns `replayed: true` without another PATCH or
history event, including older applied decisions found in immutable history.
The artifact is cloned before asynchronous work.

This is scalar field resolution. Graph relations retain their dedicated sync
adapter. Existing relation base values are preserved; a missing legacy base
stays absent until sync can establish complete agreement. No revisions-feed
reconciliation is added. Fixture acceptance does not establish live Azure
permissions or custom organization process rules.


## Measured offline acceptance

Public `unbraind/pm-ado` tracker at
`1fe0a306e13417115e66de9b48ac2e50deaa25d1`, copied into a non-git scratch
directory: **28 certified items**, **224 field comparisons**, **28 synthetic
title conflicts**, **28 valid plans**, **28 omitted-choice refusals**. Plans
averaged **2,576 JSON bytes**. Fingerprints before/after confirmed copied source
files unchanged; SDK runtime caches are excluded. All overlays were in memory,
including an explicit `canceled` → `Removed` state map. Azure writes: **0**.

Reproduce with `node scripts/validate-resolution-corpus.ts "$PUBLIC_PM_COPY"`,
where the variable names an archived public tracker root outside a git repo.
The script reads real pm rows through `listAllComplete`; the Azure side uses the
[recorded REST 7.1 response fixture](../test/fixtures/resolutions/README.md).
Successful applies, revision races and actual CLI rendering are measured
separately on disposable real SDK trackers by `test/sync.test.ts`.
