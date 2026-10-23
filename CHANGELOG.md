# Changelog

## 2026.9.2 - 2026-09-02

### Breaking Changes

- Map typed work item relations onto pm parent and dependency kinds in both directions ([pm-ado-1zuu](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/features/pm-ado-1zuu.toon))

### Added

- Resolve sync conflicts with revision-bound portable field decisions ([pm-ado-4x3u](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/features/pm-ado-4x3u.toon))
- Discover Azure project field contracts before planning sync ([pm-ado-field-contracts](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/features/pm-ado-field-contracts.toon))
- Preview Azure area and iteration moves with rule and relation evidence ([pm-ado-move-simulator](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/features/pm-ado-move-simulator.toon))
- Map typed work item relations onto pm parent and dependency kinds in both directions ([pm-ado-1zuu](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/features/pm-ado-1zuu.toon))
- Read a project through the work item batch endpoint instead of one request per item ([pm-ado-ntkc](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/features/pm-ado-ntkc.toon))
- Assert System.Rev on every write so a concurrent agent cannot silently overwrite another ([pm-ado-8zx9](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/features/pm-ado-8zx9.toon))

### Fixed

- A publish that npm accepts late is reported as failed and the GitHub Release is skipped on bun mirror lag ([pm-ado-qc9l](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-qc9l.toon))
- Consume the canonical pm-ops attestation gate rather than carrying a twentieth vendored copy ([pm-ado-1udj](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-1udj.toon))
- Fix polynomial-redos in readConfig trailing-slash regex (CodeQL alert \#1) ([pm-ado-mih0](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-mih0.toon))

### Security

- Consume the canonical attestation gate instead of carrying a copy of it ([pm-ado-ky8s](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/chores/pm-ado-ky8s.toon))

### Other

- Auto-merge green Dependabot updates and group the pm toolchain into one daily PR ([pm-ado-14nn](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/tasks/pm-ado-14nn.toon))
- Certify pm CLI 2026.9.23 and adopt the guarded pm-ops merge-driver launcher ([pm-ado-qvld](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/chores/pm-ado-qvld.toon))
- Certify pm CLI 2026.9.21 and install merge drivers through the canonical pm-ops launcher ([pm-ado-2woi](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/tasks/pm-ado-2woi.toon))
- Certify pm CLI 2026.9.17 ([pm-ado-tzyo](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/chores/pm-ado-tzyo.toon))
- Track the automated daily release for pm-ado ([pm-ado-glif](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/chores/pm-ado-glif.toon))
- Certify pm CLI 2026.9.12 and the pm-ops 2026.9.11 auditor ([pm-ado-g5y6](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/chores/pm-ado-g5y6.toon))
- Certify pm CLI 2026.9.10 and pick up the canonical auditor fixes the lockfile was holding back ([pm-ado-88lm](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/chores/pm-ado-88lm.toon))
- Scaffold the package with the fleet's mandatory gates and its own pm tracker ([pm-ado-o0ik](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/chores/pm-ado-o0ik.toon))

### Closed

- Closed: Require the existing CI matrix at the main merge boundary ([pm-ado-hawk](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-hawk.toon))
- Closed: This package claims to be publishable while its release is gated and npm answers 404, which would render an install button that cannot work ([pm-ado-tg1f](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-tg1f.toon))
- Closed: Closed the polynomial expression in the relation parser that a coverage edit had introduced ([pm-ado-muqg](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-muqg.toon))
