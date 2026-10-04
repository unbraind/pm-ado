# pm-github

A true **round-trip** GitHub Issues integration for [pm-cli](https://github.com/unbraind/pm-cli): import, export, status-sync, search, and validate.

Import issues from any GitHub repo as pm items, export pm items back to GitHub (safely, dry-run by default), push status changes upstream, reach GitHub from `pm search`, and track GitHub provenance on each item. Works unauthenticated (60 req/hr); set `GITHUB_TOKEN`/`GH_TOKEN` or run `gh auth login` for 5000 req/hr and private repos.

---

## Installation

```bash
pm install npm:pm-github --global
```

> The `npm:` prefix is required. A bare `pm install pm-github` resolves only a local
> directory or a bundled alias, never the registry, and a
> `github.com/unbraind/pm-github` source cannot work either — pm copies a GitHub
> source as-is without building it, and this repository does not commit `dist/`.

## Capabilities

| SDK capability | What it provides |
|---|---|
| `importers` | `pm github import <owner/repo>` — idempotent native import pipeline |
| `importers` (exporter) | `pm github export` — pm items → GitHub issues (dry-run by default; upsert) |
| `commands` | `pm gh-issues import` (legacy import alias), `pm github sync` (push status), `pm github validate` (diagnostics), `pm github project list\|fields\|import\|sync` (Projects v2) |
| `schema` | declares `github_url`, `github_number`, `github_state`, `github_author`, `github_created_at`, `github_updated_at` item fields |
| `hooks` | `afterCommand` — opt-in sync reminder (`PM_GITHUB_SYNC`) for linked items |
| `preflight` | early warning when a mutating github command lacks a token |
| `search` | `github` search provider — `pm search` reaches GitHub for imported items |

### Whole-workspace read safety

Import idempotency, export, status sync, Projects v2 sync, and search fallback
all depend on seeing every pm item, including closed and canceled work. Before
any of those paths plans or performs a GitHub operation, pm-github requests a
strict, full, unbounded `pm list --all` response and verifies its completeness,
omission, pagination, output-budget, count, identity, and consumed-field
contracts. An incomplete or unverifiable response fails closed; it is never
treated as an empty or partial workspace.

The production subprocess uses the same canonical argument contract as:

```bash
pm --pm-path <tracker> \
  --output-include full \
  --output-limit unbounded \
  --output-budget unbounded \
  list --all --json --include-body --strict-read
```

The output controls precede the command so the host owns the complete-result
contract; `list --all` includes terminal items without invoking the deprecated
`list-all` alias.

The subprocess still has a 64 MiB byte safety cap. Set
`PM_JSON_MAX_BUFFER=<bytes>` to a larger positive safe integer for an unusually
large tracker. Raising that transport cap does not weaken the completeness
checks.

## Import

### `pm github import <owner/repo>` (or `pm gh-issues import`)

```bash
pm github import unbraind/pm-cli
pm github import owner/repo --state all
pm github import owner/repo --labels bug,enhancement
pm github import owner/repo --since 2026-01-01T00:00:00Z   # incremental sync
pm github import owner/repo --assignee octocat
pm github import owner/repo --milestone "v1.0"
pm github import owner/repo --include-prs
pm github import owner/repo --atomic
pm github import owner/repo --link-deps    # map issue-body dependencies to pm edges
pm github import owner/repo --dry-run
```

**Flags**

| Flag | Type | Description |
|---|---|---|
| `--all` | boolean | Include closed issues (shorthand for `--state all`) |
| `--state <state>` | string | `open` \| `closed` \| `all` (default: open) |
| `--labels <labels>` | string | Comma-separated label filter |
| `--since <iso>` | string | Only issues updated after this ISO timestamp (incremental sync) |
| `--assignee <login>` | string | Filter by assignee login |
| `--milestone <name>` | string | Filter by milestone title |
| `--include-prs` | boolean | Include pull requests (default: skip PRs) |
| `--skip-drafts` | boolean | Exclude draft pull requests (only meaningful with `--include-prs`) |
| `--with-comments` | boolean | Fetch issue comments and append them to the item body |
| `--comments-mode <mode>` | `body`\|`annotations`\|`both` | How fetched GitHub comments are persisted (default `body`). `annotations` syncs comments into the pm item's native comments collection via the SDK; `both` writes the body section AND native comments. `annotations`/`both` are idempotent on re-import (dedupe by GitHub comment id) |
| `--atomic` | boolean | Commit every create, update, close, and reopen in one workspace-writer-locked, crash-resumable transaction (requires pm CLI/SDK >=2026.7.20). Normal failure compensation restores updated/closed items and deletes newly created items; an incomplete compensation is reported explicitly for retry or repair. |
| `--link-deps` | boolean | After import, map dependency references in issue **bodies** (`Blocked by #N`, `Depends on owner/repo#N`, `Blocks #N`) to pm dependency edges between the linked items. Idempotent, best-effort, and re-runnable; see [Dependency linking](#dependency-linking---link-deps) below. |
| `--dry-run` | boolean | Preview without writing |
| `--type <type>` | string | Override pm item type (default: Issue) |

Each imported item records GitHub provenance: the `gh:owner/repo#N` idempotency tag, a `github_author:<login>` tag, and an enriched description (`author @<login> · state reason <reason> · created <iso> · updated <iso>`). GitHub issues closed as `not_planned` import as pm `canceled` instead of `closed`, preserving the difference between completed work and deliberately dropped work. The integration declares the `github_url`, `github_number`, `github_state`, `github_author`, `github_created_at`, and `github_updated_at` schema fields.

`--atomic` derives its durable transaction identity from the repository, complete rendered issue state, and exact ordered mutation plan (including target item ids), and derives each create id from the stable `owner/repo#number` external key rather than fetch position. Retrying the same response in a different order therefore resumes without duplicates; changed content, workspace prefixes, or resolved targets create a fresh compatible transaction. Native comment annotations run only after the item transaction commits and retain their cross-process deduplication lock.

### Native comment sync (`--comments-mode`)

By default (`--comments-mode body`, or `--with-comments`), fetched GitHub issue comments are flattened into the item body as blockquoted markdown under a `### GitHub comments (N)` heading — the historical behavior, byte-identical across releases.

`--comments-mode annotations` instead syncs each GitHub comment into the pm item's **native comments collection** via the public SDK `comments()` primitive, so agents get structured, queryable comments (`pm comments <id>`) instead of body-embedded text. Each stored comment carries a hidden marker with the GitHub comment id (`<!-- pm-github:comment:N -->`), so re-running import is **idempotent** — already-synced comments are skipped and never duplicated. `--comments-mode both` writes the body section *and* the native comments.

When `--with-comments` is combined with `--comments-mode annotations`, the two are reconciled to `both` (the legacy flag asks for body embedding, the mode asks for native comments → both), so neither is silently dropped.

```bash
pm github import owner/repo --comments-mode annotations   # native comments only
pm github import owner/repo --comments-mode both            # body section + native comments
pm github import owner/repo --with-comments                 # legacy body embedding (default shape)
pm github import owner/repo --with-comments --comments-mode annotations  # same as --comments-mode both
```

### Dependency linking (`--link-deps`)

GitHub issue authors declare cross-issue dependencies in prose — `Blocked by #12`, `Depends on owner/repo#5`, `Blocks #9`. A flat import throws that structure away, leaving pm items with no blocker graph. `--link-deps` runs an opt-in second pass that parses those references from each issue's **body** and materializes them as pm dependency edges between the corresponding pm items, resolved through the same `gh:owner/repo#N` provenance tags the import writes.

The effect is context you can act on: `pm next` and `pm deps` surface the real ready/blocked ordering instead of an undifferentiated list.

```bash
pm github import owner/repo --link-deps
pm github import owner/repo --atomic --link-deps
pm github import owner/repo --link-deps --dry-run   # reports candidate reference count only
```

**Reference grammar** (case-insensitive; `-`/`:` glue tolerated; multiple refs like `#1, #2 and #3`):

| Phrase | pm edge on the source item |
|---|---|
| `Blocked by #N` | `blocked_by` → the referenced item |
| `Depends on #N` | `blocked_by` → the referenced item |
| `Blocks #N` | `blocks` → the referenced item |

Both bare `#N` (resolved against the imported repo) and explicit `owner/repo#N` cross-repo references are supported, the latter only when that issue is also present in the workspace.

**Guarantees**

- **Idempotent** — edges dedupe by id + kind, so re-running import never duplicates them.
- **Path-agnostic** — runs identically after the normal and `--atomic` import.
- **Safe** — references inside fenced/inline code spans are ignored; self-references and references to issues not in the workspace are skipped (the latter counted as `unresolvedDependencyRefs`); a failed individual edge never fails the import (it is reported in `dependencyLinkFailures` and the pass is re-runnable).
- **Cycle-aware, not cycle-blocking** — ordering cycles the mapped edges introduce are reported in `orderingCycleWarnings` (computed via the pm SDK `collectNewOrderingCycleWarnings` advisory over the workspace before/after the pass) rather than rejected, mirroring the SDK's warn-don't-reject contract for legacy graph debt.

The import result gains `linkedDependencies`, `unresolvedDependencyRefs`, `orderingCycleWarnings` (and `dependencyLinkFailures` when non-empty); a `--dry-run --link-deps` result reports `wouldLinkDependencyCandidates`.

## Export (pm → GitHub)

### `pm github export`

**Safe by default.** Export previews the create/update plan and writes *nothing* unless you explicitly opt in with `--apply` **and** name a `--repo`. With a `--repo`, items already linked to an issue in that repo (via the `gh:owner/repo#N` provenance tag) are **updated** (upsert) instead of duplicated.

```bash
pm github export --repo owner/repo            # DRY-RUN: print the create/update plan, write nothing
pm github export --repo owner/repo --format md
pm github export --repo owner/repo --ids pm-12,pm-34
pm --json github export --repo owner/repo     # return the plan as JSON
pm github export --repo owner/repo --apply    # actually create/update issues (requires a token)
pm github export --repo owner/repo --ids pm-12,pm-34 --apply
```

| Flag | Type | Description |
|---|---|---|
| `--repo <owner/repo>` | string | Target repo; decides create-vs-update and is required for `--apply` |
| `--ids <pm-1,pm-2>` | string | Scope export to specific pm item IDs (comma-separated); unknown IDs fail fast |
| `--format <json\|md>` | string | Dry-run output format (default: json) |
| `--apply` | boolean | Perform real GitHub writes (alias: `--no-dry-run`, legacy `--push`). Requires a token + `--repo` |
| `--dry-run` | boolean | Force preview even alongside `--apply` (dry-run always wins) |

## Status sync (pm → GitHub state)

### `pm github sync`

Push pm status changes back to GitHub: close/reopen the linked issue to match the pm item's status. Requires a token and explicit `--repo`.

```bash
pm github sync --repo owner/repo --dry-run    # preview the close/reopen plan
pm github sync --repo owner/repo --ids pm-12,pm-34 --dry-run
pm github sync --repo owner/repo              # push the changes
```

`--ids` scopes sync to specific pm item IDs (comma-separated). Unknown IDs fail fast so agent runs do not silently skip typoed targets.

## GitHub Projects v2 (bidirectional board sync)

GitHub Projects v2 boards are a GraphQL-only surface, distinct from Issues. These commands keep a pm workspace and a Projects v2 board in lockstep — *project management = context management* — **without ever losing data**: nothing is deleted or archived on either side, every action is idempotent via a `gh-project:owner/number#itemId` provenance tag, and a pm status (or board Status) that has no clear counterpart is **skipped, never guessed**.

Needs a token with `project`/`read:project` scope (`GITHUB_TOKEN`/`GH_TOKEN` or `gh auth login`).

### `pm github project list <owner>`

Discover the Projects v2 owned by a user or org (read-only).

```bash
pm github project list unbraind
pm github project list unbraind --json
```

### `pm github project fields <owner/number>`

Introspect a board's fields and — crucially — its **Status** single-select options, so you can design a `--status-map` (read-only).

```bash
pm github project fields unbraind/5
```

### `pm github project import <owner/number>`

Import every board item (draft issues included) as pm items. Idempotent: an item already linked (by project tag, or by the `gh:repo#N` issue it wraps) is **updated, not duplicated**. The board's Status option maps to the pm status.

```bash
pm github project import unbraind/5 --dry-run
pm github project import unbraind/5
pm github project import unbraind/5 --status-map in_progress=Doing,closed=Shipped
```

### `pm github project sync <owner/number>`

Bidirectionally sync pm items and a board. **Safe by default**: with no `--apply` it previews *both* directions and writes nothing.

- `--push` (pm → board): adds missing pm items to the board — attaching the existing GitHub issue when the pm item is issue-linked, otherwise creating a draft issue — and sets each item's **Status** from its pm status.
- `--pull` (board → pm): updates each linked pm item's status from the board's Status column (status only — never touches title/body/tags).
- `--apply` writes; with neither direction flag it defaults to `--push` (so pm is never mutated silently).
- `--prefer pm|github` resolves conflicts when applying both directions (default `pm`).

```bash
pm github project sync unbraind/5                                  # preview both directions
pm github project sync unbraind/5 --push --apply                  # pm → board
pm github project sync unbraind/5 --pull --apply                  # board → pm
pm github project sync unbraind/5 --push --pull --apply --prefer pm
pm github project sync unbraind/5 --push --apply --ids pm-1,pm-2  # scope by id
pm github project sync unbraind/5 --push --apply --no-add-missing # only reconcile linked items
```

> The GitHub Projects v2 item node id is case-sensitive but pm normalizes tag values to lowercase, so the node id is hex-encoded inside the provenance tag to round-trip losslessly. This is what makes re-sync idempotent instead of silently double-adding.

## Search (pm search → GitHub)

### `github` search provider

Registers a `github` search provider so `pm search ... --semantic` can reach GitHub. It asks GitHub which issues in the target repo match your query, then returns hits for the **pm items you've already imported** from those issues (matched by the `gh:owner/repo#N` provenance tag).

```bash
pm config project set ...                      # set search.provider = "github" in .agents/pm/settings.json
export PM_GITHUB_REPO=owner/repo               # or pass the repo another way
pm search "uppercase dashes" --semantic        # hits = imported items whose upstream issue matches
```

Enable it by setting `search.provider` to `"github"` in `.agents/pm/settings.json` and pointing it at a repo via the `PM_GITHUB_REPO` env var.

## Validate / diagnostics

### `pm github validate`

Read-only check of the integration: `gh` CLI presence, token resolvability (and source), and—with `--repo`—repo accessibility. When `--repo` is given it also surfaces the remaining GitHub API quota (`X-RateLimit-Remaining`/`Limit`/`Reset`) and warns when the quota is running low. Never mutates anything.

```bash
pm github validate
pm github validate --repo owner/repo
pm --json github validate --repo owner/repo
```

## License

MIT

## Release Automation

This package is release-ready for GitHub, npm, and Bun-compatible installs. CI runs type checking, build, production dependency audit, package packing, Bun install verification, and pm-changelog validation. The daily release workflow publishes only when commits exist after the latest release tag and uses pm-changelog to generate CHANGELOG.md and GitHub release notes.

## Multi-agent merge safety

This repo tracks its project management in `.agents/pm/` and ships a committed `.gitattributes`
that maps those tracker artifacts to pm-cli's field-aware Git merge drivers, so concurrent-branch
tracker edits merge cleanly. The driver definitions live in per-clone Git config; `npm install` /
`npm ci` wires them automatically via the `prepare` script, `scripts/prepare-merge-driver.ts`: the launcher template pm-ops ships, copied unchanged, which a test compares byte for byte with the pinned template. It runs pm-ops's installer, which calls `pm merge install` when the `pm` CLI is on `PATH` and skips with a notice when it is not. A production install of a clone (`npm ci --omit=dev`) has no `pm-ops`, so the launcher skips with one notice, while a stale or broken `pm-ops` fails the install. Registry installs of this package never run `prepare`. Being Node-based, it behaves identically on POSIX shells and Windows `cmd.exe`. To (re)run
manually: `npm run merge:install`.

After merging a branch that touched `.agents/pm/`, reconcile any residual history-hash drift with
**`pm merge reconcile`** (pm-cli ≥ 2026.7.22): preview with `pm merge reconcile --dry-run`, apply with
`pm merge reconcile --message "post-merge reconcile"`, then confirm with `pm validate`, which scans the
whole tracker and flags remaining history drift across **every** affected item (`pm merge reconcile`
itself lists each affected stream in its output; `pm history --verify <id>` spot-checks one item). The field-aware driver already unions every author's
content, so `reconcile` only re-greens the hash chain (no data loss) — see the authoritative
[pm-cli merge-safety guide](https://github.com/unbraind/pm-cli/blob/main/docs/MERGE_SAFETY.md). The
older blunt `pm history-repair --all` remains available as a lower-level primitive.
