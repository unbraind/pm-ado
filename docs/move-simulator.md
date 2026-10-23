# Preview area and iteration moves

```sh
# ADO_ORG_URL and ADO_TOKEN are supplied through the environment.
# The identity needs Work Items read/write for Azure's validation endpoint.
pm ado move-preview --project Example --items example-a,example-b \
  --area-path 'Example\Delivery' --iteration-path 'Example\Release' --json
pm ado move-preview --project Example --items example-a \
  --iteration-path 'Example\Release' --output-format toon
```

The command selects **only** the exact comma-separated pm IDs. Import/link them
first; unlinked, duplicate, ambiguous or missing selections refuse before any
request. Use the project **name**, and project-rooted classification paths.
Omitting a dimension preserves its observed value. One type is inspected
(`--type Task` by default). Wrong-project or other-type work items are refused.

`rows` contain pm/Azure IDs, observed revisions, before/after area and iteration,
`decision: allowed|refused`, typed `code` and `remedy`. They omit item bodies,
titles, identities and remote error text. `ok` is false if any row refuses;
row refusals are successful diagnostic output (exit 0). Whole-preview refusals
include `exit_code`: 2 for input/selection/budget, 3 for service/schema/permissions,
4 for the shared contract fingerprint changing. Inspect every row before any
separate application workflow. There is no apply, save or implicit bulk-update
option, and the preview never writes pm items.

The implementation reuses `discoverProjectContract`, `AdoClient` batch reads,
`buildUpdatePatch`, `relationTargetId` and the host SDK's `listAllComplete`.
It sends metadata GETs, read-only workitemsbatch POSTs and revision-checked
PATCH requests with **validateOnly=true&bypassRules=false**. Azure evaluates
conditional process rules and the authenticated identity's effective permissions,
including inherited area denials; the validator does not save changes. Redirects
are refused, requests time out after 30 seconds and there are no retries.
An allowed row means that individual server validation passed at that revision.
It does not reserve permissions, lock metadata or make a multi-item transaction.
A later application must be explicitly requested and independently revalidate.

`relations` cover at most 200 direct outgoing links from the selected snapshot,
including Azure's reverse hierarchy/dependency references when present. Links
are preserved; moving classifications does not reparent work items or rewire
dependencies. `before`/`after` report whether the endpoints share the area and
iteration if **all allowed** proposals move and refused rows stay put. Opaque,
foreign or unreadable targets use null boundaries; no external URL is emitted.
This is classification scope evidence, not a team-board membership calculation,
transitive impact analysis or an atomic prediction across independent requests.

Bounds are 50 selected items, 200 direct links, one type contract (four requests),
at most two batch reads, and at most one validation per selected item: **56 remote
requests maximum**. Empty neighbor batches make zero requests. A relation budget
failure refuses the whole preview before any validations. Discovery errors
never produce a partial contract. `--expect-fingerprint` uses the same field
contract pin as `ado contract`; metadata is not crawled a second way.

```ts
import { simulateMove, MoveRefusal, ContractRefusal } from "pm-ado";
import type { AdoTransport } from "pm-ado";

const request: AdoTransport = async (method, url, body, headers) => {
  const response = await fetch(url, {
    method, body, headers, redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.text() };
};

// pm is an existing host-bound PmClient; complete reads carry SDK census checks.
try {
  const result = await simulateMove({
    orgUrl: "https://dev.azure.com/example", project: "Example",
    token: process.env.ADO_TOKEN!,
  }, request, {
    items: (await pm.listAllComplete()).items,
    ids: ["example-a", "example-b"],
    iterationPath: "Example\\Release",
  });
  console.log(result.rows, result.relations, result.requests);
} catch (error) {
  if (error instanceof MoveRefusal || error instanceof ContractRefusal) {
    console.error(error.code, error.remedy);
  } else throw error;
}
```

SDK transports must preserve HTTP statuses, reject redirects and enforce a
timeout. The CLI supplies that transport. Source trackers can have SDK-derived
cache activity; use a read-only copy when validating source immutability. The
same SDK and installed CLI work in a plain non-git tracker, with no git executable
on PATH. Azure credentials are unnecessary for the synthetic REST tests; live
Azure behavior remains a separate acceptance boundary.

REST references: [work item validation without saving and rule enforcement](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/update?view=azure-devops-rest-7.1),
[area path permissions and inheritance](https://learn.microsoft.com/en-us/azure/devops/organizations/security/set-permissions-access-work-tracking?view=azure-devops).

## Public fleet-copy measurement

The public `unbraind/pm-ado` tracker at
`3592ce90e40331217021b053c479402642a23478` was exported to a plain scratch
directory. A complete SDK read found **29 items**; **63 authoritative files**
remained byte-identical. Unmodified items have no Azure provenance and correctly
refused selection at **zero requests**.

A synthetic Azure projection retained those real public IDs, lifecycle states
and eight direct relations, adding only in-memory classification/provenance and
fixture permission/rule inputs. It yielded **7 allowed**, **6 inherited area
denials**, **16 conditional iteration refusals**, **5 relation boundary changes**,
**34 requests**, **11,057 JSON bytes**, and **62 ms** for the first preview.
Reversed-selection replay was identical and no remote fixture item changed.
These are real tracker-copy and synthetic Azure measurements, **not live Azure
acceptance**. No source tracker, credentials or private project data were used.

Reproduce with the repo-pinned dependencies installed:

```sh
scratch=$(mktemp -d)
git archive 3592ce90e40331217021b053c479402642a23478 .agents/pm | tar -x -C "$scratch"
GIT_CEILING_DIRECTORIES="$(dirname "$scratch")" \
  node test/real-data-moves.ts "$scratch" 3592ce90e40331217021b053c479402642a23478
```

The validator hashes every authoritative file, asserts a zero-network unlinked
refusal, runs the projected scenario twice and checks both local and remote
immutability. It accepts a copy only; it performs no pm mutations.
