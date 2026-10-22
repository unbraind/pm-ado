# Inspect an Azure project before planning sync

```sh
export ADO_ORG_URL=https://dev.azure.com/example
# Supply ADO_TOKEN through the environment with Work Items read access.
pm ado contract --project Example --type Task --check-tracker --json
pm ado contract --project Example --type Task --output-format toon
# Re-read the same scope and refuse changes to the observed metadata:
pm ado contract --project Example --type Task --expect-fingerprint <sha256> --json
```

The response includes `preview: true`, `checked_items`, `skipped_items`,
`compatible`, `issues` with typed `code`, `target`, aggregate `count` and `remedy`, plus a fingerprint.
For example, `read_only` on `Task/System.Title` means exporting title would be
incompatible; `required_unmapped` on `Task/Custom.CostCenter` means the adapter
needs a mapping or the process needs a default. With `--type`, enabled items
of other project types are skipped and counted separately. Unknown or disabled
types remain incompatibilities; they count as assessed items. No sync plan is
constructed.

```ts
import { discoverProjectContract, ContractRefusal } from "pm-ado";
import type { AdoTransport } from "pm-ado";

const request: AdoTransport = async (method, url, body, headers) => {
  const response = await fetch(url, {
    method, body, headers, redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.text() };
};

try {
  const contract = await discoverProjectContract({
    orgUrl: "https://dev.azure.com/example",
    project: "Example",
    token: process.env.ADO_TOKEN!,
  }, request, { type: "Task" });
  console.log(contract.compatible, contract.fingerprint, contract.issues);
} catch (error) {
  if (error instanceof ContractRefusal) console.error(error.code, error.remedy);
  else throw error;
}
```

SDK callers can pass `items: (await pm.listAllComplete()).items` from an existing
host-bound client, and their existing `exportStates`/`importStates` maps. The
adapter never reimplements tracker scanning, output rendering, or state/field
conversion. The optional `expectedFingerprint` rejects changed metadata with
`schema_changed` and exit 4. Fingerprints are order-independent, use
locale-independent UTF-16 code-unit ordering, and are scoped to the organization,
project and selected type metadata, excluding local items and
configured maps. They are observations, not a transactional lock on Azure.

Only GET requests are sent. The REST transport supplied by SDK callers must
reject redirects, enforce timeouts and preserve the response status. The
discovery CLI transport already does so, while the existing sync transport keeps
its redirect behavior. A failed endpoint refuses the whole discovery rather than
presenting a partial contract as complete. No server response body,
credential or authorization header is included in refusal output. Configuration
validation errors retain exit 2; SDK schema/tracker reads and unexpected conversion
failures return `remote_failure` with exit 3 and a local-read remedy.

Known limits: allowed values are only enumerations Azure exposes; identity,
area/iteration and state-dependent rules can require further administrator
validation. Required metadata is unconditional (`alwaysRequired`); dependent
field references are preserved, not evaluated. The metadata lists and their
fingerprint can change between reads. This feature does not grant edit/link
permissions or change sync behavior. Use a read-only tracker copy for previews
when the host's derived caches must also remain untouched on the source.

REST 7.1 contracts: [fields](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/fields/list?view=azure-devops-rest-7.1),
[type fields with allowed/default/required properties](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-item-types-field/list?view=azure-devops-rest-7.1),
[types and states](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-item-types/list?view=azure-devops-rest-7.1),
and [organization relation capabilities](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-item-relation-types/list?view=azure-devops-rest-7.1).
