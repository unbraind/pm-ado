# Typed relation adapters

[pm-ado-1zuu](../.agents/pm/features/pm-ado-1zuu.toon) implements import and
export of typed work-item links through the package library. The CLI registers
`ado validate`; full project sync orchestration is separate work.

| ADO reference name | Local representation | Export direction |
| --- | --- | --- |
| `System.LinkTypes.Hierarchy-Reverse` | Source item's `parent` | Child to parent |
| `System.LinkTypes.Hierarchy-Forward` | Target item's `parent` | Parent to child |
| `System.LinkTypes.Dependency-Reverse` | `blocked_by` dependency | Successor to predecessor |
| `System.LinkTypes.Dependency-Forward` | `blocks` dependency | Predecessor to successor |
| `System.LinkTypes.Related` | `related` dependency | Both ends |
| `System.LinkTypes.Duplicate-Forward` | `related` with exact `source_kind` | Original Duplicate direction |
| `System.LinkTypes.Duplicate-Reverse` | `related` with exact `source_kind` | Inverse Duplicate direction |
| Configured custom reference | Configured pm kind plus exact `source_kind` | Original reference name |

The current SDK mutation parser accepts only its built-in dependency enum, even
when an extension registers a relationship kind. It has no `duplicate` kind.
The adapter therefore stores Duplicate as a provenance-bearing `related` edge.
Distinct Related, Duplicate and custom references to the same target remain
separate dependencies because `source_kind` retains their meanings. Graph
consumers can inspect that field to distinguish them. This SDK gap does not
prevent lossless remote dependency round-tripping.

## Usage

These adapters require pm CLI/SDK 2026.10.4 or newer, matching the tested
complete-list and provenance contracts. The package declares that floor in its
peer dependency and extension manifest.

The caller creates or resolves local items first, supplies a one-to-one identity
table, and binds a real SDK client to the target tracker. The adapter adds no
runtime SDK import to the extension; it uses the caller's client.

```ts
import { PmClient } from "@unbrained/pm-cli/sdk";
import { AdoClient, importRelations, exportRelations } from "pm-ado";

// config and transport come from the caller; tests supply offline HTTP fixtures.
const client = new AdoClient(config, transport);
const pm = new PmClient({ pmRoot: ".agents/pm", noExtensions: true, author: "ado-agent" });
const identities = new Map([[101, "project-parent"], [102, "project-child"]]);
const custom = { "Custom.Checks": "verifies" } as const;
const remote = await client.getWorkItems([...identities.keys()]);
const imported = await importRelations(remote, config.orgUrl, identities, pm, custom);

for (const item of remote) {
  const plan = await exportRelations(item, config.orgUrl, identities, pm, custom);
  // Surface imported.unmapped, plan.unmapped and plan.unmappedLocal to the operator.
  if (plan.operations.length > 0) {
    await client.updateWorkItem(item.id, item.rev, {}, plan.operations);
  }
}
```

Custom names must contain only letters, digits, dots, underscores and hyphens;
they cannot override built-in names. Supported SDK aliases normalize to their
canonical kind. Dependency provenance preserves the exact custom reference.
Custom hierarchy names retain their original spelling from the expanded remote
snapshot. Distinct existing reference names survive for the same hierarchy
edge; repeated copies of the same reference are removed. Incoming local blockers, Related and Duplicate edges export their
inverse endpoint too. Configure both directed custom dependency endpoints when
the remote type uses separate forward and reverse names. A unique custom name
for the inverse kind is used; when none is configured, the built-in relation map
provides the fallback. If multiple custom names map to the inverse kind, export
reports the incoming edge in `unmappedLocal` with its original `source_kind`
instead of guessing. Existing remote links for that ambiguous endpoint are
retained and reported in `unmapped`.

## Preservation and refusal

Import reads the entire tracker, including terminal items, with
`listAllComplete`. It merges links additively, preserving independent local
links. It never interprets a missing remote link as permission to erase local
structure. Re-importing identical links changes neither documents nor history.
This API does not implement deletion reconciliation or a full project sync.

Before any import write, the adapter validates the final hierarchy across all
items, including legacy hierarchy dependencies. Self cycles, disconnected
cycles and competing remote parents fail with a conflict. Valid reparenting
applies parent changes in the validated final tree's topological order, moving
ancestors before descendants. This computes an empty minimal detach set and
avoids transient cycles without unsetting existing parents. If an SDK write
fails, completed parent changes are compensated in reverse order, restoring
original parents (including originally parentless items). Recovery continues
when one restoration fails; the error includes failed restoration IDs and exact
currently detached IDs from a fresh complete tracker read, and retains the
original failure as its cause. Successful dependency additions remain additive.
Each SDK mutation still applies its own locking and hierarchy checks; the
whole multi-item import is not a single transaction against concurrent writers.

Export requires the revision-bearing remote snapshot with `relations` expanded.
It removes stale recognized links, retains surviving annotations, removes
repeated copies in descending index order and appends each new link once.
Unknown remote types, unsafe/foreign target URLs and targets outside the identity
table are reported and retained. Local unmapped kinds/targets are also reported.
Missing custom configuration reports the retained dependency provenance; it
does not invent a built-in alias for that edge.
Only canonical same-organization work-item URLs with safe positive IDs can be
translated. Callers must inspect the returned diagnostics to assess completeness.

`updateWorkItem(id, rev, fields, operations)` combines fields and relation
operations behind its leading `test /rev`. A stale revision rejects the whole
patch; a diagnostic re-read does not replay it. Empty plans require no write.

## Offline acceptance

`test/ado.test.ts` uses the repository's scripted and stateful HTTP fixture
pattern and real disposable SDK trackers. It exercises both source and built
`dist/index.js`: standard and custom round-trips, same-target reference
provenance, no-op re-sync/history, unknown retention, reciprocal endpoints,
cycle refusal, valid reparenting, stale-link removal and revision conflicts.
No test uses an Azure DevOps service or real credentials.

Run `npm run build && npm run build:test && node --test test/ado.test.ts`.
The repository gates are `npm run release:check` and `bun run release:check`;
these validate the candidate without releasing it. They retain the configured
100% measured Node V8 lines, branches and functions. Statement enforcement is
an existing separate gap tracked by [pm-ado-5w3m](../.agents/pm/issues/pm-ado-5w3m.toon).

## Behavioral revert evidence

Three independent temporary function mutations retained all exports and test
imports, rebuilt the package successfully, and failed on behavioral assertions:

- Removing `mapRelations` deduplication failed `duplicate mapping`: 2 links
  returned where 1 was expected.
- Returning an empty `exportRelations` plan (the previous field-only behavior)
  failed `export removes stale`: no operations instead of removals at indices
  3, 2 and 1.
- Disabling only the import cycle preflight failed `batch hierarchy preflight`:
  the SDK rejected the cycle eventually, but one parent mutation had already
  entered the tracker history.

The commands were `npm run build` followed by
`node --test --test-name-pattern='duplicate mapping' test/ado.test.ts`,
`node --test --test-name-pattern='export removes stale' test/ado.test.ts` and
`node --test --test-name-pattern='batch hierarchy preflight' test/ado.test.ts`.
After restoring the implementation, the combined pattern passed all three tests.


## PR #18 data-integrity review evidence

Real disposable tracker tests inject a failure at each of five SDK updates,
forwarding every other call to the real SDK. They assert that every original
parent is restored and no forward update detaches a parent. Separate recovery
failures verify exact detached-ID reporting and continued compensation. Two
custom dependency pairs sharing `blocks`/`blocked_by` exercise ambiguous inverse
diagnostics in both directions, remote-link retention, unique-match resolution
and the built-in fallback. All run against source and built exports.

Independent temporary reverts preserved exports and rebuilt successfully:

- Reverting only hierarchy ordering/compensation failed both source and built
  tests on `update 2: every previous parent must be restored`: the earlier item
  remained detached after the injected second update failure.
- Reverting only inverse resolution failed both source and built tests because
  `Custom.Precedes` incorrectly exported `Custom.After` rather than reporting
  ambiguity with provenance.

After each revert, the fix was restored and the package rebuilt. The commands
were `npm run build` and then either
`node --test --test-name-pattern='parent update failure' test/ado.test.ts` or
`node --test --test-name-pattern='ambiguous custom inverse' test/ado.test.ts`.
The restored combined regression command is
`node --test --test-name-pattern='parent update failure|failed parent compensation|ambiguous custom inverse' test/ado.test.ts`.
