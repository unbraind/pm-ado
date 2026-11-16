# Fleet CI v2

Required checks remain `test (22)` and `test (26)`. PRs and dispatch use
GitHub-hosted runners, quick deterministic seed prefixes, cancellation and 30 minute
job limits. Main pushes, dispatch and nightly 02:41 UTC run four distinct deep
jobs: Node 22/26 × npm/Bun, one full gate each, with 120 minute limits and scale 3.
The local pool is used unless PM_LOCAL_DEEP is off. Local npm cache is persistent;
Bun is preinstalled and its version is logged. Release scheduling is unchanged.

| Check | PR Node 22 | PR Node 26 | Docs/tracker only (both) | Deep (each matrix leg) |
| --- | --- | --- | --- | --- |
| npm ci, strict pm health and merge drivers | install | yes | yes | yes |
| Build and committed dist drift | yes | yes | — | yes |
| Tests / property sequences | quick | quick coverage | applicable docs suites | full |
| Typecheck, docstrings | — | release gate | — | release gate |
| Coverage (100% statements/lines/branches/functions unchanged) | — | quick | — | full |
| Production audit and pack dry run | — | yes | pack dry run | yes |
| Changelog consistency | — | yes | yes | yes |
| Publish attestation / tracker-derived changelog date | via tests | yes | date verifier | yes |
| Native monotonic precondition probe | — | yes | — | yes |
| Identity audit | via tests | via tests | yes | via tests |
| SDK docs, tracker-linked selectors and license contracts | via tests | via tests | yes | via tests |
| Public API contracts | via tests | via tests | — | via tests |
| Packed npm/global/npx/Bun/global/bunx/copied extension acceptance | via tests | via tests | — | via tests |
| Bun graph smoke | — | yes | — | yes |
| CodeQL (not required) | separate workflow, code paths | separate workflow | filtered | main code paths + unchanged weekly schedule |

The docs path includes SDK documentation tests, tracker-command audits, package dry run and release/license contracts, in addition to identity and changelog.
There is no lint script. No original gate is removed; exhaustive coverage remains
after merge. Packed acceptance already proves Bun and bunx installation paths;
the extra smoke only installs the graph. Test depth defaults to full; quick uses
one tenth rounded up, at least 25, retaining seed order. Small exhaustive matrices
and product size boundaries are unchanged. Scaled packed watchdogs validate a
finite positive factor before launching children and round up milliseconds.
The adversarial URL timing check is a harness regression budget, not a product SLA.

Owner measurement: 39,929 fleet runner-minutes in 24 h; median PR wall time
45–90 min including about 28 min queueing. New timings are pending PR execution;
full depth is deliberately not run on the overloaded development host.
Supersedes wave-1 PR #109; that PR remains open. Companion: pm-cli-website-dyhg.

## Measurements

Initial quick PR run 43757691680 failed the publish verifier after 12m54s
(Node 26) and 13m26s (Node 22), measured from job creation to completion.
The verifier refuses dynamic command executables; deep now uses explicit
conditional npm and Bun steps, each matrix job still executing exactly one gate.
The unchanged verifier and its eight tests pass locally after this correction.
Final-head CI is pending.

| Corpus | Quick PR Node 26 | Full previous main Node 26 |
| --- | --- | --- |
| Sync model (50 / 500) | 19.00 s | 571.86–655.41 s |
| Two-sided model (52 / 512) | 47.11 s | 2052.45–2352.34 s |
| Packed acceptance (unchanged scenarios) | 119.12 s | 150.44–178.52 s |

These are different runs, with different contention, rather than controlled
hardware comparisons. Full depth was not run locally. Local strict health has
an existing managed-extension host version mismatch, tracked separately; hosted
strict health passed. Final quick coverage and the full deep matrix remain
uncertified until their workflows complete.
