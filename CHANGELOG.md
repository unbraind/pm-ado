# Changelog

## 2026.9.2 - 2026-09-02

### Breaking Changes

- Map typed work item relations onto pm parent and dependency kinds in both directions ([pm-ado-1zuu](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/features/pm-ado-1zuu.toon))
- Reject cross-organization and imprecise Azure DevOps relation targets ([pm-ado-ns93](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-ns93.toon))

### Added

- Import, export and reconcile Azure DevOps work items with revision-checked commands ([pm-ado-nc7z](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/features/pm-ado-nc7z.toon))
- Map typed work item relations onto pm parent and dependency kinds in both directions ([pm-ado-1zuu](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/features/pm-ado-1zuu.toon))
- Read a project through the work item batch endpoint instead of one request per item ([pm-ado-ntkc](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/features/pm-ado-ntkc.toon))
- Assert System.Rev on every write so a concurrent agent cannot silently overwrite another ([pm-ado-8zx9](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/features/pm-ado-8zx9.toon))

### Changed

- Adopt pm-github 2026.10.16: default-branch-safe gated sync and daily gated closeout PRs ([pm-ado-m8c1](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/chores/pm-ado-m8c1.toon))
- Enable the gated GitHub issue sync ([pm-ado-fiw8](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/chores/pm-ado-fiw8.toon))

### Fixed

- Enforce the declared statement-coverage threshold instead of silently ignoring it ([pm-ado-5w3m](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-5w3m.toon))
- Reject cross-organization and imprecise Azure DevOps relation targets ([pm-ado-ns93](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-ns93.toon))
- A publish that npm accepts late is reported as failed and the GitHub Release is skipped on bun mirror lag ([pm-ado-qc9l](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-qc9l.toon))
- Consume the canonical pm-ops attestation gate rather than carrying a twentieth vendored copy ([pm-ado-1udj](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-1udj.toon))
- Require the existing CI matrix at the main merge boundary ([pm-ado-hawk](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-hawk.toon))
- This package claims to be publishable while its release is gated and npm answers 404, which would render an install button that cannot work ([pm-ado-tg1f](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-tg1f.toon))
- Fix polynomial-redos in readConfig trailing-slash regex (CodeQL alert \#1) ([pm-ado-mih0](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-mih0.toon))

### Security

- Consume the canonical attestation gate instead of carrying a copy of it ([pm-ado-ky8s](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/chores/pm-ado-ky8s.toon))
- Closed the polynomial expression in the relation parser that a coverage edit had introduced ([pm-ado-muqg](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-muqg.toon))

### Other

- Auto-merge green Dependabot updates and group the pm toolchain into one daily PR ([pm-ado-14nn](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/tasks/pm-ado-14nn.toon))
- Certify pm-ado on PM CLI/SDK 2026.10.4 and consolidate pending dependency updates ([pm-ado-qq1p](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/chores/pm-ado-qq1p.toon))
- Certify pm CLI 2026.9.23 and adopt the guarded pm-ops merge-driver launcher ([pm-ado-qvld](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/chores/pm-ado-qvld.toon))
- Certify pm CLI 2026.9.21 and install merge drivers through the canonical pm-ops launcher ([pm-ado-2woi](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/tasks/pm-ado-2woi.toon))
- Certify pm CLI 2026.9.17 ([pm-ado-tzyo](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/chores/pm-ado-tzyo.toon))
- Track the automated daily release for pm-ado ([pm-ado-glif](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/chores/pm-ado-glif.toon))
- Certify pm CLI 2026.9.12 and the pm-ops 2026.9.11 auditor ([pm-ado-g5y6](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/chores/pm-ado-g5y6.toon))
- Certify pm CLI 2026.9.10 and pick up the canonical auditor fixes the lockfile was holding back ([pm-ado-88lm](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/chores/pm-ado-88lm.toon))
- Scaffold the package with the fleet's mandatory gates and its own pm tracker ([pm-ado-o0ik](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/chores/pm-ado-o0ik.toon))
