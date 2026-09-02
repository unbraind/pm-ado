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
write asserts a revision.

Three further Azure DevOps capabilities map onto `pm` primitives more directly than
Jira or Linear can express:

| Azure DevOps | `pm` | why it matters |
| --- | --- | --- |
| `System.Rev` plus the revisions endpoint | the append-only item history | a remote append-only log to reconcile against, instead of flattening to one `updated_at` |
| typed relations (`Parent`, `Child`, `Related`, `Duplicate`, `Predecessor`, `Successor`) | `parent` and dependency kinds | a real mapping rather than an ad hoc convention |
| the work item batch endpoint (200 sub-requests per call) | — | a project sync costs a handful of round trips, not hundreds: directly an agent's latency and token budget |

## Status

Early. The package is scaffolded, tracked with `pm` in this repository, and gated by
the same mandatory quality gates as the rest of the fleet: 100% coverage across
statements, branches, functions and lines, a 100% docstring gate, CodeQL, and a
publish-attestation gate that refuses a release whose `npm publish` would run without
`--provenance`.

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
