# Independent statement coverage

Tracked by [pm-ado-5w3m](../.agents/pm/issues/pm-ado-5w3m.toon).

## Problem and reproduction

Before the change, `coverageGate.thresholds.statements=100` was silently ignored.
The built npm archive was installed into a real scratch pm tracker, and offline
`ado validate` returned its revision-asserting-write diagnostic without an Azure
request. A fixture then ran the gate against this source:

```ts
export function value(flag: boolean) { if (flag) { return 42; } return 7; }
```

Calling only `value(true)` passed the old gate with statements=100. The new
regression retains lines=100 and functions=100, sets branches=0 to isolate the
statement dimension, and fails with statements 2/3. Calling both paths reaches
3/3 and passes. No threshold or behavior was removed to obtain coverage.

## Measurement and enforcement

The original suite measures Node V8 lines, branches and functions and writes
`coverage/lcov.info`. A second suite instruments the same enumerated TypeScript
sources after native type stripping with Istanbul AST counters. Its generated
preload substitutes only configured sources; Node child processes inherit it so
launcher behavior is measured too. Each worker writes its counters at exit;
the gate merges workers and filters unrelated source records out of its summary.
The second pass keeps instrumentation out of the original V8 measurements.

Missing statement maps/counters, missing required sources, invalid counters,
invalid JSON and missing reports fail closed, including at a zero threshold.
Statement reports are cleared before the measurement starts, and old reports
cannot rescue a runner that writes nothing. Startup, suite and signal failures
stop the gate. Existing Node options are preserved. Counts are compared without
rounding: the exact measured threshold passes, a fraction above it fails.

`coverage/statements/summary.json` stores the independent aggregate;
`coverage/statements/coverage-final.json` retains merged statement maps and counters.
Generated instrumentation and reports are ignored runtime artifacts.

The unchanged required inventory is `index.ts`, `scripts/coverage-gate.ts`,
`scripts/prepare-merge-driver.ts` and `scripts/docstring-gate.ts`. This is the
configured four-source coverage scope, not every operational script in the repo.

## Regression proof and validation

Behavioral revert: remove only the statement measurement/enforcement call and
its status check from `runCoverageGate`, leaving imports, implementation and tests
intact. Run:

```sh
node --test --test-name-pattern='statement threshold rejects|statement report fails closed' test/coverage-gate.test.ts
```

Both tests load and fail assertions because the gate returns 0 instead of 1.
Restoring the call makes both tests pass. The full suite adds real worker merge,
exact-boundary, malformed/missing/stale report and runner failure scenarios.

Verified local results on Node 24.19.0 and Bun 1.3.5:

- `npm run release:check`: PASS, 129/129 tests in each coverage pass, zero skips.
- `bun run release:check`: PASS, 129/129 tests in each coverage pass, zero skips.
- Independent statements: 306/306 (100%); V8 lines/branches/functions: 100% each.
- Docstring gate: 38/38 declarations; production audit: zero vulnerabilities.
- Pack dry run, changelog check, provenance attestation and version-date gates: PASS.
- `pm test pm-ado-5w3m --run --progress`: focused suite PASS, 30/30.
  Project test-result recording is disabled, so results are recorded in pm comments.
- The rebuilt archive also passes offline validation in a real scratch tracker;
  the partial-statement fixture now exits 1.

Required validation commands:

```sh
npm run release:check
bun run release:check
npm run changelog:full
```

Release approval remains owner gated. This change does not enable or execute a
release, publish, tag, live Azure write or merge. Live Azure integration and
remote CI/review evidence remain separate from the local gate results.
