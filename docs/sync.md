# Azure DevOps import, export and sync

`pm ado import`, `pm ado export` and `pm ado sync` run through the pm host.
The package requires pm CLI 2026.10.23 or newer. Sync uses its host-bound SDK and structured
nonzero command receipts. The SDK/devDependency pin is unchanged. These commands
have offline REST-contract acceptance; live Azure acceptance awaits an
organization and Work Items read/write credentials.

## Configuration and selection

Set `ADO_ORG_URL`, `ADO_PROJECT` and `ADO_TOKEN` as described in the README.
Credentials are checked before tracker reads and network calls, including previews
that need remote snapshots. Tokens never appear in command receipts.
Optional configuration variables are:

| Variable | Meaning |
| --- | --- |
| `ADO_STATUS_MAP` | JSON object overriding Azure state to pm status, e.g. `{"Review":"in_progress"}` |
| `ADO_EXPORT_STATE_MAP` | JSON object overriding pm status to Azure state, e.g. `{"in_progress":"Review","canceled":"Removed"}` |
| `ADO_WORK_ITEM_TYPE` | Creation type when `--type` is absent; defaults to `Task` |

```sh
pm ado import --area-path 'Project\Area' --iteration-path 'Project\Sprint' --type Task
pm ado import --wiql "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'Project'"
pm ado export --limit 25 --dry-run --json
pm ado sync --limit 100 --dry-run --output-format toon
pm ado sync --limit 100 --json
```

Generated WIQL selects the configured project, adds exact area/iteration/type
filters, escapes apostrophes and orders by ID. `--wiql` cannot be combined with
those filters and must select flat work items. Import/sync batch-read the selected
IDs in groups of at most 200 (with a server-side WIQL result limit), with expanded relations and explicit omission
reporting. An omitted selected work item fails the command before item writes.

`--limit` is a positive integer (default 100) bounding primary items. Export
selects pm items in the SDK's complete-list order, including unlinked and terminal
items. Sync selects remote query results first, then unlinked pm items up to the
remaining limit. Linked items outside the query are not exported. Relation
adapters can update an existing linked endpoint outside the primary selection.
Export rejects the import-only WIQL, area and iteration filters.
Use a dedicated tracker or a small preview before exporting unlinked items.
Azure scope mismatches and duplicate numeric identities fail closed.

## Field map

| Azure field | pm field | Normalization |
| --- | --- | --- |
| `System.Title` | `title` | String |
| `System.Description` | `description` | String; Azure HTML is retained verbatim |
| `System.State` | `status` | Default map below; overrides above |
| `Microsoft.VSTS.Common.Priority` | `priority` | Integer 0–4, missing value defaults to 2; Azure process rules still apply on export |
| `System.Tags` | `tags` | Semicolon list to a lowercase, sorted unique set; JSON-array SDK input preserves commas in individual tags |
| `System.AssignedTo` | `assignee` | Identity `uniqueName`, falling back to `displayName`; empty remote assignment clears the local scalar |
| `System.AreaPath` | `ado_area_path` | Dedicated string field |
| `System.IterationPath` | `ado_iteration_path` | Dedicated string field |
| `System.WorkItemType` | `ado_type` | Recorded provenance; `--type`/configuration selects creation type |
| ID, revision, project, organization, URL | `ado_id`, `ado_rev`, `ado_project`, `ado_org_url`, `ado_url` | Remote identity and write precondition |
| Last agreed canonical values | `ado_sync_base` | JSON string stored by SDK mutations and therefore present in append-only item history |

Default import states: New, Proposed and To Do → `open`; Active, Committed and
Doing → `in_progress`; Blocked → `blocked`; Resolved, Done, Closed and Removed →
`closed`. Default export states: `open` → New, `in_progress` → Active, `blocked` →
Active, `closed` → Closed. Unsupported states fail with a configuration error.
Azure processes differ: configure both maps when their state vocabulary differs.
The default Active mapping cannot distinguish an Azure blocked item. Sync
preserves an agreed local status while its configured remote state remains
unchanged; configure a distinct remote state if the process supports it.

Other pm fields, comments, body and evidence collections are preserved.
Typed relations use the existing [relation adapters](typed-relations.md), including
same-organization URL validation, hierarchy-cycle refusal, inverse links and
unknown-link preservation. Diagnostics expose unmapped remote and local links.
Commands currently use the built-in relation map; custom reference mappings remain
available through the adapter API.

## Reconciliation and revisions

Import explicitly takes remote mapped fields, resolves identities by `ado_id`,
creates missing pm items, imports links additively and records the agreed snapshot
and revision. Re-importing unchanged remote values does not rewrite items or
append history. Import is a deliberate remote-authoritative operation; use sync
when both sides may have edits.

Export creates unlinked work items with `POST .../workitems/$<type>` using Azure's
JSON Patch media type and `add` field operations. Creation has no existing
revision to assert: Azure allocates its ID and initial revision. Empty area and
iteration values are omitted so the server can apply its defaults. New identities
are allocated before their relation patches are sent. Each successful create
immediately records `ado_id`, `ado_rev`, `ado_project`, `ado_org_url` and `ado_url`
through an SDK update with append-only history. Its plan reports the remote ID
and `linked_fields` already persisted, including on a later failure. This link
has no `ado_sync_base` until reconciliation finishes, so a retry uses the linked
pair instead of creating a duplicate. A linked pair without a base can reconcile
through export or report differing fields through sync.

Every update, including relation patches, starts with `test /rev`. Field updates
use `add`, which sets existing fields and also handles optional fields absent
from the previous remote document. Explicit export always asserts the locally
stored `ado_rev`, even though it reads the current remote item to build the plan.
A 412 triggers one diagnostic batch re-read, returns the asserted and current
revisions plus differing fields, and never retries the rejected patch. The
conflicting local item and its history remain byte-for-byte unchanged.

Sync plans an import followed by an export per field, before changing either side:

| Local versus base | Remote versus base | Result |
| --- | --- | --- |
| Equal | Equal | No-op |
| Equal | Changed | Import remote field |
| Changed | Equal | Export local field |
| Changed to the same value | Changed to the same value | Accept agreement |
| Changed to different values | Changed to different values | Conflict with base/local/remote values |

The base is the dedicated `ado_sync_base` snapshot from the last successful
synchronization, not the latest edit timestamp. Without a base, matching fields
bootstrap safely and differing fields conflict. Malformed base JSON fails with
exit 2 (`ADO_USAGE`), naming the item and `ado_sync_base`.
After reconciliation, sync asserts the current remote revision it just compared,
so disjoint local and remote edits can be combined in one checked patch. A race
after that comparison is still a 412 and imports nothing into that local item.

Relations are compared as one canonical field of recognized reference-name/ID
pairs. Local-only changes export; remote additions import through the additive
adapter. Remote removals that would erase local graph structure are reported as
relation conflicts, requiring explicit resolution rather than silently restoring
or deleting an edge. Unknown links are preserved and reported. All detected
three-way conflicts stop the plan before writes. Operations across multiple
items and the two stores are not a distributed transaction: earlier successful
remote operations can remain if a later write or SDK mutation fails. The receipt
includes the item plan; inspect both stores before retrying a partial failure.

Every local sync update now uses the SDK's `commitItemMutations` with an
`updated_at` match checked under the item lock. A local edit after planning
refuses persistence with `ADO_CONFLICT` (exit 4), keeping the newer item and
history intact. Re-read both trackers before retrying; an earlier Azure write
may already have succeeded. Sync's own link and relation writes advance its
expected revision from their immutable transaction history. SDK transaction
markers are now recorded in update history messages; ordinary command receipts
and mapped values are unchanged.

## Preview and conflict receipts

`--dry-run` performs the WIQL/batch reads needed for a real plan and returns item
identities, directions and changed field names. Planning reads the complete
tracker once and shares that snapshot with relation planning. It performs no work-item
create/PATCH, no SDK item mutation and no changes to authoritative tracker
files (documents, history, settings or schemas). The host SDK may populate its
ignored derived metadata caches on reads; these are outside tracker history.
Previews also report already-stale export revisions as conflicts without a PATCH.
JSON and TOON are rendered by the host, including failures.

A three-way conflict receipt contains, for example:

```json
{
  "ok": false,
  "code": "ADO_CONFLICT",
  "exit_code": 4,
  "dry_run": false,
  "conflicts": [{
    "pm_id": "example-abcd",
    "ado_id": 101,
    "stored_rev": 7,
    "remote_rev": 8,
    "fields": {
      "title": {"base": "Original", "local": "Local edit", "remote": "Remote edit"}
    }
  }]
}
```

On 412 the same field entries contain `local` and `remote`; `remote_rev` is null
when the item disappeared before the diagnostic re-read. Exit 2 (`ADO_USAGE`)
means configuration/input needs correction; exit 3 (`ADO_REMOTE`) means a remote,
connectivity or SDK operation failed; exit 4 (`ADO_CONFLICT`) means reconciliation
or revision refusal. Credential preflight may exit 2 directly with its existing
missing-variable diagnostic. Success exits 0. Resolve conflicts explicitly,
then import an agreed snapshot or rerun sync; export never forces a stale write.

## Offline evidence

`test/sync.test.ts` starts a local HTTP server implementing the used Azure REST
7.1 contract: WIQL POST, expanded workitemsbatch, work item GET/create/PATCH,
JSON Patch content types, canonical relation URLs, and atomic revision rejection
with the Azure-style error envelope. Tests activate the real extension through
the pm registration engine, use actual CLI parser/rendering/exit handling, and
mutate real disposable SDK trackers. No SDK store is mocked and no live Azure
organization or token is used.

Run `npm run build && npm run build:test && node --test test/sync.test.ts`.
The release gates remain `npm run release:check` and `bun run release:check`
with unchanged 100% statements/lines/branches/functions and docstring thresholds.

The conflict and dry-run tests also have independent behavioral revert proofs.
Replacing only explicit export's stored revision with the fresh remote revision
builds successfully, then fails the conflict test because the actual CLI exits 0
instead of 4. Removing only the dry-run write guard also builds successfully,
then fails the tracker-file byte comparison. Restoring both guards and rebuilding
passes both focused tests. The exact commands and outcomes are recorded in
[pm-ado-nc7z](../.agents/pm/features/pm-ado-nc7z.toon).

Review-round regressions also prove that partial creates retain their SDK links
across two exports after another entry's 412, a new relation's revision conflict,
and a server error during relation publication. Moving the link mutation back
to final publication fails all three regressions. Reverting malformed-base JSON
handling returns exit 3 instead of 2; reverting snapshot reuse reads the real SDK
tracker four times instead of once for three linked pairs. Each behavioral
revert builds successfully before its regression fails.
