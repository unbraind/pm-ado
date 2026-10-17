# Dependabot prepare coverage regression

Dependabot #30 refreshes the canonical `scripts/prepare-merge-driver.ts`
when pm-ops changes. The pm-ops 2026.10.12 template adds an early return for
`npm_command=pack` and `npm_command=publish`. The install-only test harness
never exercised either artifact path. This is shared with
pm-beads#144; neither SDK behavior nor V8 counting caused the loss.

The failing CI job names line 28, the artifact notice, at 98.65% lines and
75% branches in the launcher. Last green main CI run 38890569324 used the old
template and measured 100% of each configured dimension.

The tests now select the lifecycle command explicitly and exercise both pack
and publish against real temporary Git checkouts with the installed pm-ops.
Each configures the declared drivers through the ci path, records Git config,
runs artifact prepare, and verifies successful execution and unchanged config.
The tests work with both template generations, asserting behavior rather than
hard-coding a dependency version or its notice. Canonical byte equality and
all existing broken-install checks remain enforced. Dependency pins and
coverage thresholds remain unchanged.

Revert proof: apply Dependabot's exact dependency and generated-template diff
onto main with the original tests; coverage fails. Restore only the new tests
in that same tree; coverage and the complete release gates must pass. This is
a test-only repair: reverting the changed harness and added cases is the
behavioral revert that restores the failure.

Validation uses `npm run release:check` and `bun run release:check`, each with
an empty HOME, `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`, on
the fix plus Dependabot's exact dependency and generated-template diff.
The fix branch retains its dependency pins for separate PR CI checks.

Full scratch-tree validation is run on a temporary GitHub validation branch
with the exact dependency and generated-template diff applied to the fix.
This avoids shared-host process timeouts while retaining the complete release
gates and isolated Git identity. The temporary validation workflow uses only
read permissions and runs both release-check commands; it is not part of the
fix PR.

The same artifact lifecycle gap was also confirmed in pm-changelog#248 under
full CI-identity validation, and is fixed there with the same tests.

## Completed validation

[Full npm and Bun scratch-tree gates](https://github.com/unbraind/pm-ado/actions/runs/39022613591)
at `82a87369dce74d2ba9211150b90373c8f0fca0b4` both passed. Each command passed 181/181 tests with zero failures,
skips, cancellations or todos. Lines, branches and functions measured 100%.
The separate statement gate measured 816/816 statements (100%).

Both commands used a fresh identity HOME and disabled global/system Git config:

```sh
env HOME="$(mktemp -d)" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 npm run release:check
env HOME="$(mktemp -d)" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 bun run release:check
```

The validated tree contains the fix plus the original Dependabot dependency
and generated-template changes. The validation workflow is excluded from the
fix branch. Local full runs interrupted by host load are not pass evidence.
