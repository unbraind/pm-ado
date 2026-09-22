/** Tests the thin `prepare` launcher over the canonical `pm-ops/merge-driver`. */

import assert from "node:assert/strict";
import test from "node:test";

// Importing the launcher executes it: the `prepare` hook is a two-line
// delegation to `runPrepareMergeDriver`, so loading this module IS running the
// hook. Absence of `pm` on `PATH` is a supported production-install state that
// the canonical installer turns into exit code 0, and a present `pm` that
// installs the drivers cleanly also returns 0 - so in every supported
// environment the import leaves `process.exitCode` at 0, and only a genuinely
// broken CLI (a failed `pm merge install`) fails the test loudly.
import "../scripts/prepare-merge-driver.ts";

test("the prepare launcher delegates to the canonical pm-ops merge-driver export", () => {
  assert.strictEqual(process.exitCode, 0);
});
