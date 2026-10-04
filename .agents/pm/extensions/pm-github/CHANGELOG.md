# Changelog

## 2026.9.26 - 2026-09-26

### Other

- Certify pm CLI 2026.9.23 and adopt the guarded pm-ops merge-driver launcher ([pm-github-d2az](https://github.com/unbraind/pm-github/blob/main/.agents/pm/chores/pm-github-d2az.toon))

## 2026.9.22 - 2026-09-22

### Fixed

- A publish that npm accepts late is reported as failed and the GitHub Release is skipped on bun mirror lag ([pm-github-7okj](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-7okj.toon))

### Other

- Certify pm CLI 2026.9.21 and install merge drivers through the canonical pm-ops launcher ([pm-github-7azo](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-7azo.toon))

## 2026.9.18 - 2026-09-18

### Other

- Certify pm CLI 2026.9.17 ([pm-github-ksq2](https://github.com/unbraind/pm-github/blob/main/.agents/pm/chores/pm-github-ksq2.toon))

## 2026.9.13 - 2026-09-13

### Other

- Certify pm CLI 2026.9.12 and the pm-ops 2026.9.11 auditor ([pm-github-u95z](https://github.com/unbraind/pm-github/blob/main/.agents/pm/chores/pm-github-u95z.toon))

## 2026.9.11 - 2026-09-11

### Other

- Certify pm CLI 2026.9.10 and pick up the canonical auditor fixes the lockfile was holding back ([pm-github-drwr](https://github.com/unbraind/pm-github/blob/main/.agents/pm/chores/pm-github-drwr.toon))

## 2026.9.9 - 2026-09-09

### Fixed

- github import --dry-run runs the action verb into the title and emits a dangling comma when an issue has no labels ([pm-github-github-ee4d59c27b67-35](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-github-ee4d59c27b67-35.toon))

## 2026.9.8 - 2026-09-08

### Security

- Consume the canonical attestation gate instead of carrying a copy of it ([pm-github-u5qc](https://github.com/unbraind/pm-github/blob/main/.agents/pm/chores/pm-github-u5qc.toon))

### Other

- Harden the attestation consumer suite to match the rest of the converged fleet ([pm-github-xqgi](https://github.com/unbraind/pm-github/blob/main/.agents/pm/chores/pm-github-xqgi.toon))

## 2026.9.6 - 2026-09-06

### Fixed

- Match the release-date control heading as a grammar and escape the probe version ([pm-github-bi6l](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-bi6l.toon))

### Other

- Pin the pm toolchain and assert the changelog-date flag by difference ([pm-github-c5i4](https://github.com/unbraind/pm-github/blob/main/.agents/pm/chores/pm-github-c5i4.toon))

## 2026.9.4 - 2026-09-04

### Security

- The Link-header parser backtracks polynomially, so one hostile pagination header stalls every repository sync in the fleet ([pm-github-494f](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-494f.toon))

## 2026.9.1 - 2026-09-01

### Fixed

- Group codeql-action bumps into one pull request to end the split-PR deadlock ([pm-github-11qm](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-11qm.toon))

## 2026.8.31 - 2026-08-31

### Fixed

- Pin pm-changelog 2026.8.30 before the next release ([pm-github-g9g0](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-g9g0.toon))
- Regenerate the changelog after the release tag was created ([pm-github-5wzr](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-5wzr.toon))

## 2026.8.29 - 2026-08-29

### Fixed

- Validate pm CLI development dependency bump ([pm-github-j8zh](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-j8zh.toon))
- The publish-attestation gate misses a publish routed through an unquoted shell variable ([pm-github-tko1](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-tko1.toon))
- True round-trip GitHub sync: search provider, validate diagnostics, safe-by-default export, fix activation ([pm-github-9dqy](https://github.com/unbraind/pm-github/blob/main/.agents/pm/features/pm-github-9dqy.toon))
- A failed provenance publish silently falls back to an unattested one ([pm-github-i5b8](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-i5b8.toon))
- Fix release publish ordering ahead of protected main push ([pm-github-v2kt](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-v2kt.toon))
- BREAKING: pm-github now requires pm CLI 2026.8.20 or newer; older hosts may fail installation or runtime validation ([pm-github-iswq](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-iswq.toon))

## 2026.8.18 - 2026-08-18

### Fixed

- Refuse incomplete pm item corpora before GitHub imports, exports, and syncs ([pm-github-ep0u](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-ep0u.toon))

## 2026.8.17 - 2026-08-17

### Fixed

- The manifest declared a pm CLI floor of 2026.7.28 while peerDependencies required 2026.8.3, so the CLI enforced a weaker minimum than npm ([pm-github-7d1h](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-7d1h.toon))

## 2026.8.16 - 2026-08-16

### Fixed

- A github command can silently lose its preflight credential gate when the override scope drifts from the mutating command set ([pm-github-4ga9](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-4ga9.toon))

## 2026.8.15 - 2026-08-15

### Fixed

- Scope preflight override to pm-github's owned commands ([pm-github-yhhz](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-yhhz.toon))

## 2026.8.10 - 2026-08-10

### Fixed

- Propagate the docstring gate entry guard fix ([pm-github-wb4q](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-wb4q.toon))
- Converge changelog generation and verification on replace mode ([pm-github-8f60](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-8f60.toon))
- The mandatory docstring gate could skip its own scan and still exit zero ([pm-github-wxob](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-wxob.toon))

### Other

- Adopt the canonical pm-ops docstring gate ([pm-github-pbxd](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-pbxd.toon))

## 2026.8.7 - 2026-08-07

### Other

- Gate CI on strict tracked pm project health ([pm-github-eh1h](https://github.com/unbraind/pm-github/blob/main/.agents/pm/chores/pm-github-eh1h.toon))

## 2026.8.4 - 2026-08-04

### Fixed

- Fix terminal transitions for pm-cli 2026.8.3 close_reason enforcement ([pm-github-rwq9](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-rwq9.toon))

### Other

- Resolve pm-changelog to the release that derives release dates in UTC ([pm-github-9m6j](https://github.com/unbraind/pm-github/blob/main/.agents/pm/chores/pm-github-9m6j.toon))

## 2026.7.30 - 2026-07-30

### Other

- Raise pm-github sync coverage from 76% toward the 100% mandate ([pm-github-n3z3](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-n3z3.toon))

## 2026.7.29 - 2026-07-29

### Added

- Enforce a real coverage gate by running tests against TypeScript sources ([pm-github-uv1a](https://github.com/unbraind/pm-github/blob/main/.agents/pm/features/pm-github-uv1a.toon))

### Other

- Adopt pm-cli 2026.7.29 ([pm-github-801z](https://github.com/unbraind/pm-github/blob/main/.agents/pm/chores/pm-github-801z.toon))

## 2026.7.28 - 2026-07-28

### Other

- Adopt pm-cli 2026.7.28 ([pm-github-b646](https://github.com/unbraind/pm-github/blob/main/.agents/pm/chores/pm-github-b646.toon))
- Adopt pm-cli 2026.7.27 in pm-github ([pm-github-iai5](https://github.com/unbraind/pm-github/blob/main/.agents/pm/chores/pm-github-iai5.toon))
- Eliminate all 37 any usages from pm-github source with real GitHub Projects V2 GraphQL types and typed handler contexts ([pm-github-1wka](https://github.com/unbraind/pm-github/blob/main/.agents/pm/chores/pm-github-1wka.toon))

## 2026.7.27 - 2026-07-27

### Removed

- Adopt pm-cli 2026.7.26 typed authoring contracts and remove the any-cast defineExtension shim ([pm-github-zjxx](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-zjxx.toon))

## 2026.7.26 - 2026-07-26

### Fixed

- Documented install command fails: pm install github.com/unbraind/pm-github cannot resolve an entry file ([pm-github-q6ql](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-q6ql.toon))

### Other

- Enable governance duplicate-detection advisory mode and adopt pm-cli 2026.7.25 ([pm-github-suxt](https://github.com/unbraind/pm-github/blob/main/.agents/pm/chores/pm-github-suxt.toon))

## 2026.7.25 - 2026-07-25

### Added

- Search pm items in any public GitHub repo (gh-authenticated, semantic search) ([pm-github-r8y0](https://github.com/unbraind/pm-github/blob/main/.agents/pm/features/pm-github-r8y0.toon))

### Fixed

- Import dies with an unexplained pm list-all failed on any tracker over 1 MiB, and non-atomic --dry-run previews every issue as a create ([pm-github-tn92](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-tn92.toon))
- CHANGELOG omits the shipped --link-deps feature and mislabels 2026.7.23 work as Unreleased ([pm-github-px45](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-px45.toon))

### Other

- Adopt --respect-item-release in changelog scripts and bump pm-changelog to 2026.7.24 ([pm-github-w7m7](https://github.com/unbraind/pm-github/blob/main/.agents/pm/chores/pm-github-w7m7.toon))

## 2026.7.23 - 2026-07-23

### Added

- Import --link-deps: map GitHub issue-body dependency references (Blocked by/Depends on/Blocks \#N) into pm dependency edges + emit ordering-cycle advisory via collectNewOrderingCycleWarnings ([pm-github-hdai](https://github.com/unbraind/pm-github/blob/main/.agents/pm/features/pm-github-hdai.toon))

### Fixed

- Recommend pm merge reconcile (2026.7.22) over raw history-repair in Multi-agent merge safety docs ([pm-github-wpit](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-wpit.toon))

## 2026.7.21 - 2026-07-21

### Other

- Make GitHub issue imports atomic and crash-resumable ([pm-github-1jez](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-1jez.toon))

## 2026.7.18-1 - 2026-07-18

### Other

- Serialize marker-dedupe read-and-append across concurrent imports ([pm-github-503u](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-503u.toon))
- Harden release bun-verify so registry-mirror lag cannot block the GitHub release ([pm-github-i6af](https://github.com/unbraind/pm-github/blob/main/.agents/pm/chores/pm-github-i6af.toon))

## 2026.7.17 - 2026-07-17

### Added

- Opt-in native comment sync (GitHub comments → pm comments collection) ([pm-github-p9gp](https://github.com/unbraind/pm-github/blob/main/.agents/pm/features/pm-github-p9gp.toon))

## 2026.7.13-1 - 2026-07-13

### Fixed

- Route GitHub export dry-run preview to stderr so stdout stays valid JSON ([pm-github-urs1](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-urs1.toon))

### Other

- Spawn pm.cmd via shell on win32 in export test workspace helper ([pm-github-1nlw](https://github.com/unbraind/pm-github/blob/main/.agents/pm/chores/pm-github-1nlw.toon))

## 2026.7.13 - 2026-07-13

### Added

- Productionize GitHub Projects v2 bidirectional sync ([pm-github-jkr6](https://github.com/unbraind/pm-github/blob/main/.agents/pm/features/pm-github-jkr6.toon))
- GitHub Projects v2 bidirectional sync (import/sync/list/fields) ([pm-github-y27r](https://github.com/unbraind/pm-github/blob/main/.agents/pm/features/pm-github-y27r.toon))
- Full pm ecosystem production pass for pm-github ([pm-github-9eei](https://github.com/unbraind/pm-github/blob/main/.agents/pm/features/pm-github-9eei.toon))

### Fixed

- Export --apply aborts the whole batch on the first failed item ([pm-github-q3lk](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-q3lk.toon))
- export --apply exits 0 even when every item fails to write ([pm-github-77wj](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-77wj.toon))

### Security

- Resolve final Projects v2 review findings ([pm-github-0g3p](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-0g3p.toon))

### Other

- Full-cycle hardening wave: pm-github ([pm-github-mdcw](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-mdcw.toon))

## 2026.7.11 - 2026-07-11

### Other

- Adopt current pm SDK and TypeScript 7 toolchain ([pm-github-sq5l](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-sq5l.toon))

## 2026.7.6 - 2026-07-06

### Fixed

- Fix release CI ordering (publish-before-tag) ([pm-github-cexq](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-cexq.toon))

### Other

- Align Node engine with pm CLI runtime ([pm-github-zinh](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-zinh.toon))
- Regenerate CHANGELOG after pm close item ([pm-github-um6d](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-um6d.toon))

## 2026.6.13 - 2026-06-13

### Other

- Daily Release publish step runs prepublishOnly post-tag: align npm publish with --ignore-scripts ([pm-github-za4r](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-za4r.toon))

## 2026.6.7 - 2026-06-07

### Added

- Preserve GitHub not-planned closures as canceled pm items ([pm-github-54tv](https://github.com/unbraind/pm-github/blob/main/.agents/pm/features/pm-github-54tv.toon))

### Other

- Harden release readiness checks ([pm-github-1r09](https://github.com/unbraind/pm-github/blob/main/.agents/pm/chores/pm-github-1r09.toon))
- Align package dependencies to pm CLI/SDK 2026.6.6 ([pm-github-ctqq](https://github.com/unbraind/pm-github/blob/main/.agents/pm/chores/pm-github-ctqq.toon))

## 2026.6.4 - 2026-06-04

### Added

- Import GitHub author + timestamps, rate-limit visibility, --skip-drafts ([pm-github-v0c3](https://github.com/unbraind/pm-github/blob/main/.agents/pm/features/pm-github-v0c3.toon))

## 2026.6.3 - 2026-06-03

### Added

- Domain-max SDK enhancement: idempotent import, sync, preflight, renderer ([pm-github-mdlp](https://github.com/unbraind/pm-github/blob/main/.agents/pm/features/pm-github-mdlp.toon))

### Changed

- Idempotent import: match by github_number, update not duplicate; populate schema fields ([pm-github-fhiv](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-fhiv.toon))

### Fixed

- True round-trip GitHub sync: search provider, validate diagnostics, safe-by-default export, fix activation ([pm-github-4elt](https://github.com/unbraind/pm-github/blob/main/.agents/pm/features/pm-github-4elt.toon))
- FIX: add 'preflight' to manifest capabilities (activation-breaking bug) ([pm-github-qndb](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-qndb.toon))

### Other

- Provenance scheme: gh:owner/repo\#N tag (lowercased), reused as-is ([pm-github-ggt3](https://github.com/unbraind/pm-github/blob/main/.agents/pm/decisions/pm-github-ggt3.toon))
- Export defaults to dry-run; real writes need --apply AND --repo ([pm-github-epdt](https://github.com/unbraind/pm-github/blob/main/.agents/pm/decisions/pm-github-epdt.toon))
- Search provider maps remote matches to LOCAL items only ([pm-github-o7jl](https://github.com/unbraind/pm-github/blob/main/.agents/pm/decisions/pm-github-o7jl.toon))
- Unit tests + functional verification + README + decisions ([pm-github-f3xf](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-f3xf.toon))
- Export: dry-run default + upsert existing issues by provenance ([pm-github-fv0x](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-fv0x.toon))
- github search provider (search capability) ([pm-github-5sbx](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-5sbx.toon))
- github validate diagnostics command ([pm-github-rroh](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-rroh.toon))
- preflight capability: validate token/gh auth + repo reachability before mutating github commands ([pm-github-jget](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-jget.toon))
- pm github sync: push pm status -\> GitHub close/reopen, guarded by token+--repo+--dry-run ([pm-github-yted](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-yted.toon))
- renderers capability: register 'github' output format (pm items as GitHub-issue markdown) ([pm-github-vvov](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-vvov.toon))
- Rate-limit/backoff handling (Retry-After / X-RateLimit-Reset) + useful afterCommand hook ([pm-github-rx1q](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-rx1q.toon))
- Import issue comments via --with-comments (append to item body) ([pm-github-kvl1](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-kvl1.toon))
- Tests + functional verification against real public repo (idempotent re-import) ([pm-github-2u0d](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-2u0d.toon))
- Production-readiness audit 2026-05-28 ([pm-github-0y40](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-0y40.toon))

## 2026.6.2 - 2026-06-02

### Added

- Adopt full SDK capability surface: native importer/exporter, schema fields, afterCommand hook, richer import flags ([pm-github-gh83](https://github.com/unbraind/pm-github/blob/main/.agents/pm/features/pm-github-gh83.toon))

## 2026.6.1 - 2026-06-01

### Fixed

- Thrown errors lacked exitCode → runtime re-invoked handler (double fetch) ([pm-github-fgay](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-fgay.toon))

## 2026.5.29 - 2026-05-29

### Added

- Production-harden gh-issues import ([pm-github-lixc](https://github.com/unbraind/pm-github/blob/main/.agents/pm/features/pm-github-lixc.toon))

### Fixed

- Failed imports exited 0 (broke automation) ([pm-github-msh0](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-msh0.toon))
- Issue list truncated at one page (no pagination) ([pm-github-v4la](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-v4la.toon))
- Importer was unauthenticated (60 req/hr, no private repos) ([pm-github-gtnp](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-gtnp.toon))
- --dry-run silently wrote items instead of previewing ([pm-github-2u31](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-2u31.toon))

## 2026.5.28 - 2026-05-28

### Added

- Add publish retry + provenance fallback to release workflow ([pm-github-4ouy](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-4ouy.toon))

## 2026.5.27 - 2026-05-27

### Added

- Add bun-install verification to release workflow ([pm-github-np9v](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-np9v.toon))

## 2026.5.26 - 2026-05-26

### Fixed

- ci: fix release workflow step ordering ([pm-github-pnr1](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-pnr1.toon))

### Other

- Release readiness hardening for pm-github ([pm-github-kc0d](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-kc0d.toon))
