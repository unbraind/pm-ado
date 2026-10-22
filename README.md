# pm-ado

Azure DevOps work-item sync for [`pm-cli`](https://github.com/unbraind/pm-cli).

## Why this is not just another tracker bridge

Azure DevOps is the one major tracker whose write API is natively conflict-aware.
Work items are updated with a JSON Patch document, and that document may carry a
`test` operation asserting the current `System.Rev`:

```jsonc
[
  { "op": "test",    "path": "/rev", "value": 42 },
  { "op": "replace", "path": "/fields/System.State", "value": "Active" }
]
```

If another writer moved the item first, the **whole patch is rejected atomically**
rather than silently overwriting their edit. That is a compare-and-swap on a remote
tracker, and it is the primitive `pm` already organises itself around for multi-agent
work. Every other integration in this fleet performs last-write-wins updates and can
lose a concurrent edit. `pm-ado` does not have to, so it does not: **every** remote
update asserts a revision. Creation allocates its first revision on the server.

Three further Azure DevOps capabilities map onto `pm` primitives more directly than
Jira or Linear can express:

| Azure DevOps | `pm` | why it matters |
| --- | --- | --- |
| `System.Rev` plus the revisions endpoint | the append-only item history | a remote append-only log to reconcile against, instead of flattening to one `updated_at` |
| typed relations (`Parent`, `Child`, `Related`, `Duplicate`, `Predecessor`, `Successor`) | `parent` and dependency kinds | a real mapping rather than an ad hoc convention |
| the work item batch endpoint (200 sub-requests per call) | — | a project sync costs a handful of round trips, not hundreds: directly an agent's latency and token budget |

The relation mapper accepts only canonical work-item URLs from the configured
organization with positive, exactly representable IDs. Foreign organizations,
attachments, malformed URLs and imprecise IDs are reported as unmapped instead of
being linked to a different local item. The same-organization URL check follows
[Azure DevOps' work-item update and relation contract](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/update?view=azure-devops-rest-7.1).

## Status

The package registers `pm ado validate`, `pm ado import`, `pm ado export` and
`pm ado sync`. Commands use the host SDK for item mutations, expanded batch
reads, revision-checked updates, typed relation adapters and a dedicated base
snapshot for per-field three-way reconciliation. Conflicts have structured
receipts and nonzero exits; dry-run previews perform no item or remote writes.

[Sync command usage, field maps and conflict semantics](docs/sync.md) document the
implemented behavior and preservation boundaries. The command suite is accepted
against a local Azure REST contract server and real disposable pm trackers.
**Live Azure acceptance is pending organization credentials.** The
[package epic](.agents/pm/epics/pm-ado-g4v1.toon) remains open.

See [typed relation usage and semantics](docs/typed-relations.md) for the SDK API,
custom mappings, preservation rules and offline acceptance evidence.

This repository is tracked with `pm` and gated by
the same mandatory quality gates as the rest of the fleet: 100% independent Istanbul statement coverage and 100% measured Node V8
lines, branches and functions, a 100% docstring gate, CodeQL, and a
publish-attestation gate that refuses a release whose `npm publish` would run without
`--provenance`. The coverage gate runs the suite twice: once with Node V8
coverage, then with AST statement instrumentation across the same required source
inventory. Missing or invalid statement counters fail even at a zero threshold;
worker counters are merged and the configured threshold is compared without
rounding. [Statement-coverage evidence](docs/statement-coverage.md) records the
regression scenario, revert proof and measured four-source scope. These local
checks do not establish live Azure integration or release approval.

Publishing to npm is **deliberately gated** behind `PM_RELEASE_APPROVED`, as it is for
every new package in this fleet, until the repository is approved as carrying no
private data in its entire history.

## Configuration

| variable | meaning |
| --- | --- |
| `ADO_ORG_URL` | e.g. `https://dev.azure.com/your-org` |
| `ADO_PROJECT` | the project name |
| `ADO_TOKEN` | a personal access token with Work Items (read & write) |

A credential preflight aborts a network-mutating command **before** any store read or
remote call when these are absent, so a missing token fails fast instead of half way
through a sync.

## Licence

MIT — see [LICENSE](./LICENSE).

## Project field-contract discovery

Run `pm ado contract --project Example --type Task --check-tracker --json` before
planning a sync. The project must be selected explicitly; `ADO_PROJECT` is not a
fallback for discovery. Set `ADO_ORG_URL` and `ADO_TOKEN` with **Work Items read**.
Omit `--type` to discover every project type, including custom and disabled types;
use it to keep agent output small. The host renders JSON or compact TOON
(`--output-format toon`). The command returns metadata without work item bodies.

The typed `discoverProjectContract` SDK export returns writable/read-only fields,
required/allowed/default values, dependent fields, states, relation capabilities
and mapping incompatibilities. `--check-tracker` reads a complete certified SDK
snapshot and aggregates incompatible values/types. With `--type`, enabled items
of other remote types are counted in `skipped_items`; unknown/disabled types
still produce incompatibilities. `checked_items` counts assessed items. It shares
the existing sync field conversions and state maps (`ADO_STATUS_MAP`, `ADO_EXPORT_STATE_MAP`).
Discovery uses only GET requests and makes no item/history/settings mutations.
The host may populate disposable derived read caches.

`ok` means discovery succeeded; `compatible` means no known mapping issue was
found. Effective field/link write ACLs and conditional process rules remain
**unknown**: relation `enabled`/`editable` flags do not grant caller permissions.
Have a project administrator verify these before authorizing writes. Discovery
is an explicit pre-planning step; it does not change the existing sync commands.

Save the returned fingerprint and pass `--expect-fingerprint <sha256>` on a fresh
discovery to refuse schema drift. Permission, scope, schema and configuration
failures return typed codes plus remedies. SDK schema/tracker read failures use
`remote_failure`, not a configuration remedy. Shell exits are 2 (configuration),
3 (metadata/permission/network), or 4 (schema drift). Mapping incompatibilities
are successful diagnostic results; inspect `compatible` before planning.
See the [SDK and CLI example](docs/field-contracts.md).

## Without git

`ado validate`, `ado contract`, `ado import`, `ado export` and `ado sync` work in
plain trackers without git. Network operations still need Azure configuration;
contract discovery requires an explicit project. Package release/changelog and
GitHub workflows need a git checkout and are separate from tracker operations.
