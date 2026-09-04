# Changelog

## 2026.9.2 - 2026-09-02

### Fixed

- Require the existing CI matrix at the main merge boundary ([pm-ado-hawk](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-hawk.toon))
- This package claims to be publishable while its release is gated and npm answers 404, which would render an install button that cannot work ([pm-ado-tg1f](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-tg1f.toon))
- Fix polynomial-redos in readConfig trailing-slash regex (CodeQL alert \#1) ([pm-ado-mih0](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-mih0.toon))

### Security

- Closed the polynomial expression in the relation parser that a coverage edit had introduced ([pm-ado-muqg](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-muqg.toon))

### Other

- Scaffold the package with the fleet's mandatory gates and its own pm tracker ([pm-ado-o0ik](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/chores/pm-ado-o0ik.toon))
