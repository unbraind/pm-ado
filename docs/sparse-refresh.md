# Sparse refresh plans

`pm ado refresh-plan --fields title,status,relations --json` probes linked Azure
revisions and returns a costed plan for follow-up reads. Omit `--json` for the
host's compact TOON renderer. Set `--max-output-bytes 131072` for a larger complete
receipt; output is refused rather than silently truncated. The default JSON
budget is 65536 bytes; the accepted range is 1024..1048576.

```ts
import { PmClient } from "@unbrained/pm-cli/sdk";
import { observeRefreshPlan, compileRefreshPlan } from "pm-ado";

const pm = new PmClient({ pmRoot: ".agents/pm", author: "refresh-agent" });
const config = { orgUrl: "https://dev.azure.com/example", project: "Example", token: process.env.ADO_TOKEN! };
const request = async (method: string, url: string, body: string | undefined,
  headers: Readonly<Record<string, string>>) => {
  const response = await fetch(url, { method, body, headers, redirect: "error", signal: AbortSignal.timeout(30000) });
  return { status: response.status, body: await response.text() };
};
const plan = await observeRefreshPlan(pm, config, request, ["title", "status", "relations"]);
console.log(plan.cost, plan.accounting);

// Pure/offline compilation of already-obtained revision evidence:
const preview = compileRefreshPlan({
  needs: ["title", "relations"],
  saved: [
    { id: 1, revision: 7, base: ["title", "relations"] },
    { id: 2, revision: 4, base: ["title"] },
    { id: 3, revision: 2, base: [] },
  ],
  observed: [{ id: 1, revision: 7 }, { id: 2, revision: 5 }],
});
// unchanged=[1], changed=[2], unavailable=[3]; one sparse hydrate batch for ID 2.
// Every field accounts for one cached cell, one read cell, one unavailable cell.
console.log(preview);
```

The SDK exports `RefreshInput`, `RefreshSaved`, `RefreshRevision`, `RefreshField`,
`RefreshBatch`, `RefreshPlan`, `RefreshRefusal` and its code union. Inputs use one
strict schema: exact keys, dense unique arrays, at most 10000 linked items,
positive int32 IDs/revisions, nine known native fields, and an integer output
budget. No caller objects are mutated. In a probe-only artifact, accounting uses
`pending` until complete observations arrive.

The compiler shares the existing field map and 200-ID batcher. A first phase
requests only `System.Rev`; a second phase describes the minimum shared field
projection within each deterministic, ascending-ID batch. It minimizes request
count first, then fields within each batch; it does not add requests to group
identical cache patterns. Relations add `$expand: relations` only when needed.
The [Azure 7.1 batch contract](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/get-work-items-batch?view=azure-devops-rest-7.1)
allows up to 200 IDs, an explicit `fields` projection and `errorPolicy: omit`.
1000 selected items therefore need at most five reads per phase. `field_cells`
counts actual requested cells, including fields shared across a batch, excluding
the revision guard. It counts a relation expansion as one cell, not response bytes.

`observeRefreshPlan` reads a certified SDK snapshot, probes revisions through the
existing `AdoClient`, then reads the current SDK snapshot again. Exact-revision
base fields can be reused; missing bases/fields need hydration even when a
revision is unchanged. A linked identity set change refuses with `scope` and
requires another probe. Unlinked and foreign-scope records are skipped with
counted reasons. Statuses are opaque field values: selection includes every
configured lifecycle state, without inferring meaning from its name.

An omitted row is **unavailable**, covering permission changes, deletion,
transient omission and missing items without guessing which occurred. It never
becomes a local deletion. Newer or older differing revisions both require fresh
fields. Existing import/export/sync commands separately refuse older remote
revisions before applying changes and resolve terminal statuses using SDK roles.

This API and command perform zero pm mutations and zero remote writes. The
command executes the probe phase only; `hydrate` contains reviewable request
bodies, not executed reads. It changes no existing sync defaults. Artifacts
contain no cached values, title, description, credentials or mutation operations.
They are observations at their read boundaries, not an atomic cross-provider
snapshot, durable journal, recovery token or permission to apply writes. Every
invocation re-probes; consumers must re-read/reconcile hydrated revisions and
current targets before any later mutation using the existing checked sync APIs.

SDK failures throw `RefreshRefusal`; CLI failures return `ok: false`, `code`,
`remedy`, `exit_code` and exit nonzero. Codes are `invalid_input` (regenerate
bounded evidence), `scope` (re-probe after identity changes), `configuration`
(configure tracker/credentials/fields), `remote_failure` (retry a fresh probe
after checking read permissions), and `output_budget` (select fewer items or
increase the complete receipt budget).

Import, export, sync and refresh preview acquire their tracker client from the
host command context. Sync requests configured status roles through that client
only when a status transition needs them. No command searches argv, PATH or the
`pm` symlink for an SDK. The separate resolution runtime is acquired lazily via
the host-installed SDK link; standalone resolution services preserve the five-argument form by importing
the installed SDK package when the optional SDK argument is omitted. Packed acceptance covers npm/Bun global bins, npx/bunx, local bins and
a copied extension whose optional module link is absent, all on non-git trackers.
