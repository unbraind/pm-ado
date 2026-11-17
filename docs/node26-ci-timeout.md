# Node 26 hosted timeout: repeated coverage passes

The 30-minute cancellations are a workload-routing defect, not evidence of a hanging Node 26 handle. The hosted workflow names the step a quick gate but calls `release:check`, whose `coverage` script runs every test twice: first with V8 coverage, then with independent Istanbul statement instrumentation. Both cancelled logs continue reporting completed tests in the second pass. Node 22 calls `npm test` once without coverage. Comparing these legs as equal work is misleading.

## Hosted evidence

| Job pair | Node 22 plain suite | Node 26 first coverage suite | Outcome |
| --- | ---: | ---: | --- |
| PR #110 | 1005.273 s | 1170.851 s | Second Node 26 pass cancelled at the job deadline |
| PR #116 | 1308.834 s | 1064.210 s | Second Node 26 pass cancelled at the job deadline |

The first coverage pass was 16.5% longer than Node 22 in #110 and 18.7% shorter in #116. Host load and instrumentation differ; these are not controlled runtime benchmarks. Neither log establishes a Node 26 performance regression or a test that never exits.

Per-test seconds (Node 22 plain / Node 26 V8 / Node 26 Istanbul where completed):

| Test | PR #110 | PR #116 |
| --- | --- | --- |
| Packed installation shapes | 138.092 / 204.039 / 176.608 | 184.951 / 153.853 / 131.926 |
| `round-3 model: 512` | 62.899 / 74.854 / cancelled before completion | 83.639 / 66.126 / 62.001 |
| Boundary matrix `sync-mixed` | 66.040 / 77.821 / 72.238 | 86.523 / 68.753 / 63.811 |
| Forward-only boundary matrix `sync` | 67.130 / 76.917 / cancelled before completion | 85.987 / 67.881 / cancelled before completion |

Sources: [#110 Node 22](https://github.com/unbraind/pm-ado/actions/runs/43857787596/job/133266408705), [#110 Node 26](https://github.com/unbraind/pm-ado/actions/runs/43857787596/job/133266409075), [#116 Node 22](https://github.com/unbraind/pm-ado/actions/runs/43911505670/job/133454485602), [#116 Node 26](https://github.com/unbraind/pm-ado/actions/runs/43911505670/job/133454486570).

## Fix and regression contract

Hosted Node 26 now uses `ci:quick`: one ordinary test pass, with typechecking, docstrings, production audit, package dry run, changelog checks, attestation checks and the native precondition probe retained. The job limit remains 30 minutes. `release:check`, `prepublishOnly`, the release workflow and CI Deep still require the full coverage gate; CI Deep retains `PM_TEST_DEPTH=full`. No coverage threshold or test assertion is weakened.

`test/ci-quick-contract.test.ts` expands script aliases to prevent accidentally adding coverage or a second suite back to the hosted command. It also verifies that deep and publication validation retain coverage. Targeted workflow-contract tests run under Node 26; full-suite and hosted-duration certification remain CI responsibilities.


## Local Node 26 reproduction

Using Node 26.13.0 with the requested network-family timeout:

```sh
PM_TEST_DEPTH=quick node --test --test-reporter=spec --test-name-pattern="round-3 model: 512|boundary matrix sync-mixed|forward-only boundary matrix sync" test/sync.test.ts
```

- boundary matrix sync-mixed: every REST/local/intent boundary preserves edits or holds an ambiguous create safely (207669.76025ms)
- round-3 model: 512 two-sided sequences preserve edits and witness every base advance (203357.595365ms)
- forward-only boundary matrix sync: every crash and second-process peer edit resumes without rollback or repair (247723.349419ms)
- tests 99
- pass 99
- fail 0
- duration_ms 659869.018666

All selected matrices completed and the process exited successfully. Local elapsed
time includes shared-host load and is not a prediction for GitHub-hosted hardware.
The contract test fails against the original main package scripts and passes
with the hosted command change. The 26 targeted workflow-contract tests also
pass directly and through `pm test --run --progress`. Typecheck, test compilation,
docstrings and changelog checking pass. This repository defines no lint script or
lint configuration; `git diff --check` passes. Exact pushed-head hosted completion
and exhaustive coverage remain unverified until CI supplies that evidence.
