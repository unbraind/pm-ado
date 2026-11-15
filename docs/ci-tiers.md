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
| Production audit and pack dry run | — | yes | pack contracts via public API suite | yes |
| Changelog consistency | — | yes | yes | yes |
| Publish attestation and changelog date verifiers | via tests | yes | — | yes |
| Native monotonic precondition probe | — | yes | — | yes |
| Identity audit | via tests | via tests | yes | via tests |
| SDK docs, tracker-linked selectors, public API and license contracts | via tests | via tests | yes | via tests |
| Packed npm/global/npx/Bun/global/bunx/copied extension acceptance | via tests | via tests | — | via tests |
| Bun graph smoke | — | yes | — | yes |
| CodeQL (not required) | separate workflow, code paths | separate workflow | filtered | main code paths + unchanged weekly schedule |

The docs path includes SDK documentation tests, tracker-command audits, public API
packaging and release/license contracts, in addition to identity and changelog.
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
