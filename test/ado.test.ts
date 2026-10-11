/**
 * Behavioural tests for pm-ado.
 *
 * The extension is driven through pm's real registration and activation engine
 * via `createExtensionTestHarness`, not a hand-rolled `api` double: a double
 * would assert the extension against itself and stay green through a host
 * rejection such as a flag collision that aborts command registration.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PmClient, commitImportedItem, readSettings } from "@unbrained/pm-cli/sdk";
import * as built from "../dist/index.js";

import {
  createExtensionTestHarness,
  type ExtensionTestHarness,
} from "@unbrained/pm-cli/sdk/testing";

import extension, {
  AdoClient,
  BATCH_LIMIT,
  CommandError,
  EXIT_CODE,
  MUTATING_COMMANDS,
  PATCH_MEDIA_TYPE,
  RELATION_MAP,
  STATE_MAP,
  assertsRevision,
  batchIds,
  buildUpdatePatch,
  mapRelations,
  importRelations,
  exportRelations,
  missingEnv,
  preflightMessage,
  shouldFailFast,
  readConfig,
  runCredentialPreflight,
  relationTargetId,
  type AdoWorkItem,
  type AdoTransport,
  type BatchReadResult,
  type JsonPatchOperation,
  type AdoRelation,
} from "../index.ts";

const CONFIG = { orgUrl: "https://dev.azure.com/contoso", project: "Fabrikam", token: "pat" };

/** Build a transport that records calls and replays scripted responses. */
function recordingTransport(responses: readonly { status: number; body: string }[]) {
  const calls: { method: string; url: string; body: string | undefined; headers: Readonly<Record<string, string>> }[] = [];
  let index = 0;
  const transport = async (method: string, url: string, body: string | undefined, headers: Readonly<Record<string, string>>) => {
    calls.push({ method, url, body, headers });
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return response;
  };
  return { transport, calls };
}

/**
 * A stateful fake Azure DevOps service that tracks one work item's revision.
 *
 * A PATCH whose `test` op matches the current revision succeeds and bumps the
 * revision; any other revision yields 412. A batch read returns the current
 * state. This lets tests interleave writers against a shared service rather
 * than scripting independent responses.
 */
function statefulService(itemId: number, initialRev: number, initialFields: Record<string, unknown> = {}) {
  let rev = initialRev;
  let fields = { ...initialFields };
  const calls: { method: string; url: string; body: string | undefined; headers: Readonly<Record<string, string>> }[] = [];
  const transport = async (method: string, url: string, body: string | undefined, headers: Readonly<Record<string, string>>) => {
    calls.push({ method, url, body, headers });
    if (method === "PATCH") {
      const patch = JSON.parse(body!) as JsonPatchOperation[];
      const testOp = patch[0];
      if (testOp !== undefined && testOp.op === "test" && testOp.path === "/rev" && testOp.value === rev) {
        for (const op of patch) {
          if (op.op === "replace" && op.path.startsWith("/fields/")) {
            fields[op.path.slice("/fields/".length)] = op.value;
          }
        }
        rev++;
        return { status: 200, body: JSON.stringify({ id: itemId, rev, fields }) };
      }
      return { status: 412, body: "" };
    }
    if (method === "POST" && url.includes("workitemsbatch")) {
      return { status: 200, body: JSON.stringify({ value: [{ id: itemId, rev, fields }] }) };
    }
    return { status: 200, body: "{}" };
  };
  return { transport, calls, getRev: () => rev, getFields: () => fields };
}

/**
 * A fake service where every PATCH fails with 412 regardless of revision.
 *
 * The batch read returns a fixed revision, so the loser's diagnostic re-read
 * always reports that revision and the conflict error carries both.
 */
function alwaysConflictService(itemId: number, currentRev: number) {
  const calls: { method: string; url: string; body: string | undefined; headers: Readonly<Record<string, string>> }[] = [];
  const transport = async (method: string, url: string, body: string | undefined, headers: Readonly<Record<string, string>>) => {
    calls.push({ method, url, body, headers });
    if (method === "PATCH") return { status: 412, body: "" };
    if (method === "POST" && url.includes("workitemsbatch")) {
      return { status: 200, body: JSON.stringify({ value: [{ id: itemId, rev: currentRev, fields: {} }] }) };
    }
    return { status: 200, body: "{}" };
  };
  return { transport, calls };
}

test("every update patch asserts the revision before it changes anything", () => {
  // The `test` op is what turns a lost update into a visible failure, so it has
  // to lead the document — Azure DevOps evaluates it before applying the rest.
  const patch = buildUpdatePatch(42, { "System.Title": "new" });
  assert.deepEqual(patch[0], { op: "test", path: "/rev", value: 42 });
  assert.deepEqual(patch[1], { op: "replace", path: "/fields/System.Title", value: "new" });
  assert.ok(assertsRevision(patch));

  // An empty change set must NOT yield an unchecked write: a caller cannot
  // obtain one by passing no fields.
  const empty = buildUpdatePatch(7, {});
  assert.equal(empty.length, 1);
  assert.ok(assertsRevision(empty));
});

test("assertsRevision rejects a document that does not lead with the assertion", () => {
  assert.equal(assertsRevision([]), false);
  assert.equal(assertsRevision([{ op: "replace", path: "/fields/System.Title", value: "x" }]), false);
  assert.equal(assertsRevision([{ op: "test", path: "/fields/System.Rev", value: 1 }]), false);
});

test("a stale revision is reported as a conflict naming the item and both revisions, not a transport error", async () => {
  // Azure DevOps answers a failed `test` with 412. That is the revision race,
  // and it is the one remote failure a caller resolves by re-reading. The
  // error must name the item id and both revisions so the caller knows what
  // changed and by how much.
  const { transport, calls } = alwaysConflictService(11, 4);
  const client = new AdoClient(CONFIG, transport);
  await assert.rejects(
    () => client.updateWorkItem(11, 3, { "System.State": "Active" }),
    (error: unknown) => {
      assert.ok(error instanceof CommandError);
      assert.equal(error.exitCode, EXIT_CODE.conflict);
      assert.match(error.message, /11/u); // item id
      assert.match(error.message, /asserted rev 3/u); // asserted revision
      assert.match(error.message, /current rev is 4/u); // current revision
      return true;
    },
  );
  // The document that went out asserted the revision it was read at.
  const sent = JSON.parse(calls[0]!.body!) as JsonPatchOperation[];
  assert.deepEqual(sent[0], { op: "test", path: "/rev", value: 3 });
  assert.equal(calls[0]!.headers["Content-Type"], "application/json-patch+json");
  assert.equal(calls[0]!.method, "PATCH");
});

test("a 412 on a non-PATCH request is a remote error, not a conflict", async () => {
  // A 412 on a GET or POST is not a revision assertion failure — it is a
  // transport error. The guard on `method` in the request layer keeps the
  // conflict exit code specific to PATCH, so a caller does not mistake a
  // broken read for a revision race.
  const { transport } = recordingTransport([{ status: 412, body: "" }]);
  await assert.rejects(
    () => new AdoClient(CONFIG, transport).queryIds("SELECT 1"),
    (error: unknown) => error instanceof CommandError && error.exitCode === EXIT_CODE.remote,
  );
});

test("two writers racing one work item: the loser is refused rather than overwriting the winner", async () => {
  // The first writer wins on the revision it read. The second writer read the
  // same revision, so its assertion no longer holds and the service refuses the
  // whole document — the property that makes concurrent agents safe here.
  //
  // The loser is NOT retried onto the new revision. Replaying writer B's fields
  // onto rev 8 would set System.State to a value chosen without ever seeing
  // writer A's change, silently discarding it. That is the lost update this
  // assertion exists to prevent, so refusal is the correct outcome and the
  // winner's value must survive.
  const service = statefulService(5, 7);

  // Writer A wins: asserts rev 7, succeeds, rev becomes 8.
  const first = await new AdoClient(CONFIG, service.transport).updateWorkItem(5, 7, { "System.State": "Active" });
  assert.equal(first.rev, 8);

  // Writer B read the same rev 7 and never saw A's write. It is refused.
  await assert.rejects(
    () => new AdoClient(CONFIG, service.transport).updateWorkItem(5, 7, { "System.State": "Closed" }),
    (error: unknown) => {
      assert.ok(error instanceof CommandError);
      assert.equal(error.exitCode, EXIT_CODE.conflict);
      assert.match(error.message, /asserted rev 7/u);
      assert.match(error.message, /current rev is 8/u);
      return true;
    },
  );

  // Writer A's value survives, and the item is still at A's revision.
  assert.equal(service.getFields()["System.State"], "Active");

  // The loser's PATCH asserted the stale revision and was rejected.
  const stalePatch = JSON.parse(service.calls[1]!.body!) as JsonPatchOperation[];
  assert.deepEqual(stalePatch[0], { op: "test", path: "/rev", value: 7 });
  assert.equal(service.calls[1]!.method, "PATCH");
  // The re-read is a batch call, not a per-item GET, and no third PATCH follows it.
  assert.ok(service.calls[2]!.url.includes("workitemsbatch"));
  assert.equal(service.calls.filter((call) => call.method === "PATCH").length, 2);
});

test("a conflict surfaces the item id and both revisions after exactly one attempt", async () => {
  // The service returns 412 for the PATCH and reports rev 99 on the re-read.
  // The conflict error names the item and both revisions — the one the caller
  // read at and the one the service is now at — so the failure is actionable.
  // Exactly one PATCH is sent: the write is refused, never replayed.
  const { transport, calls } = alwaysConflictService(5, 99);
  await assert.rejects(
    () => new AdoClient(CONFIG, transport).updateWorkItem(5, 7, { "System.State": "Active" }),
    (error: unknown) => {
      assert.ok(error instanceof CommandError);
      assert.equal(error.exitCode, EXIT_CODE.conflict);
      assert.match(error.message, /5/u); // item id
      assert.match(error.message, /asserted rev 7/u); // asserted revision
      assert.match(error.message, /current rev is 99/u); // current revision
      return true;
    },
  );
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 1);
  assert.equal(calls.filter((call) => call.url.includes("workitemsbatch")).length, 1);
});

test("a conflict where the item cannot be re-read surfaces the original revision", async () => {
  // If the work item was deleted between the read and the write, the re-read
  // returns nothing. The conflict error must still surface the item id and
  // the asserted revision, and note that the item could not be re-read.
  const { transport } = recordingTransport([
    { status: 412, body: "" }, // PATCH → 412 (conflict)
    { status: 200, body: JSON.stringify({}) }, // re-read → no items (deleted)
  ]);
  await assert.rejects(
    () => new AdoClient(CONFIG, transport).updateWorkItem(5, 7, { "System.State": "Active" }),
    (error: unknown) => {
      assert.ok(error instanceof CommandError);
      assert.equal(error.exitCode, EXIT_CODE.conflict);
      assert.match(error.message, /5/u);
      assert.match(error.message, /rev 7/u);
      assert.match(error.message, /could not be re-read/u);
      return true;
    },
  );
});

test("a transport error during the diagnostic re-read is surfaced, not masked as a conflict", async () => {
  // If the re-read itself fails with a transport error (not a 412), that error
  // propagates directly rather than being swallowed or misclassified as a
  // conflict. The caller sees the real failure: the service is unreachable.
  const { transport } = recordingTransport([
    { status: 412, body: "" }, // PATCH → 412 (conflict)
    { status: 503, body: "" }, // re-read → 503 (transport error)
  ]);
  await assert.rejects(
    () => new AdoClient(CONFIG, transport).updateWorkItem(5, 7, { "System.State": "Active" }),
    (error: unknown) => error instanceof CommandError && error.exitCode === EXIT_CODE.remote && /503/u.test(error.message),
  );
});

test("a non-conflict write error is not reclassified as a conflict", async () => {
  // A 503 on the PATCH is a transport error, not a revision race. It must
  // propagate directly without triggering the diagnostic re-read, so the caller
  // sees a remote failure rather than a spurious conflict.
  const { transport, calls } = recordingTransport([{ status: 503, body: "" }]);
  await assert.rejects(
    () => new AdoClient(CONFIG, transport).updateWorkItem(5, 7, { "System.State": "Active" }),
    (error: unknown) => error instanceof CommandError && error.exitCode === EXIT_CODE.remote && /503/u.test(error.message),
  );
  // Only the failed PATCH — no re-read, no retry.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "PATCH");
});

test("a thrown transport error (not a CommandError) is propagated unchanged", async () => {
  // If the transport itself throws (a network failure before any HTTP
  // response), the error is not a CommandError. It must propagate directly
  // rather than being caught and misclassified.
  const transport: AdoTransport = async () => {
    throw new Error("network down");
  };
  await assert.rejects(
    () => new AdoClient(CONFIG, transport).updateWorkItem(5, 7, { "System.State": "Active" }),
    (error: unknown) => error instanceof Error && !(error instanceof CommandError) && /network down/u.test(error.message),
  );
});

test("a project read costs one batch call per two hundred items, not one per item", async () => {
  const ids = Array.from({ length: BATCH_LIMIT * 2 + 1 }, (_value, index) => index + 1);
  assert.deepEqual(batchIds([]), []);
  assert.equal(batchIds(ids).length, 3);
  assert.equal(batchIds(ids)[0]!.length, BATCH_LIMIT);
  assert.equal(batchIds(ids)[2]!.length, 1);

  const { transport, calls } = recordingTransport([
    { status: 200, body: JSON.stringify({ value: [{ id: 1, rev: 1, fields: {} }] }) },
  ]);
  const items = await new AdoClient(CONFIG, transport).getWorkItems(ids);
  // Asserted, not assumed: three calls for 401 ids, and none of them per-item.
  assert.equal(calls.length, 3);
  assert.equal(items.length, 3);
  assert.ok(calls.every((call) => call.url.includes("/_apis/wit/workitemsbatch")));
  // Each batch request uses errorPolicy: "omit" so a missing item does not
  // fail the whole batch.
  for (const call of calls) {
    const body = JSON.parse(call.body!) as { errorPolicy?: string };
    assert.equal(body.errorPolicy, "omit");
  }
});

test("a partial batch failure surfaces missing items per sub-request rather than failing the whole sync", async () => {
  // The batch returns 200 with only some of the requested items — the others
  // were not found. Because errorPolicy is "omit" the service does not fail the
  // batch call; the missing ids are surfaced per sub-request instead.
  const { transport, calls } = recordingTransport([
    { status: 200, body: JSON.stringify({ value: [{ id: 1, rev: 1, fields: {} }, { id: 3, rev: 1, fields: {} }] }) },
  ]);
  const result = await new AdoClient(CONFIG, transport).getWorkItemsReport([1, 2, 3, 4]);
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.missing, [2, 4]);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.url.includes("workitemsbatch"));
  const body = JSON.parse(calls[0]!.body!) as { errorPolicy?: string };
  assert.equal(body.errorPolicy, "omit");
});

test("a batch response without a value array contributes nothing rather than throwing", async () => {
  const { transport } = recordingTransport([{ status: 200, body: JSON.stringify({}) }]);
  assert.deepEqual(await new AdoClient(CONFIG, transport).getWorkItems([1]), []);
});

test("a WIQL query returns the ids it selected and ignores rows without one", async () => {
  const { transport, calls } = recordingTransport([
    { status: 200, body: JSON.stringify({ workItems: [{ id: 4 }, {}, { id: 9 }] }) },
  ]);
  assert.deepEqual(await new AdoClient(CONFIG, transport).queryIds("SELECT [System.Id] FROM workitems"), [4, 9]);
  assert.match(calls[0]!.url, /_apis\/wit\/wiql/u);

  const { transport: bare } = recordingTransport([{ status: 200, body: JSON.stringify({}) }]);
  assert.deepEqual(await new AdoClient(CONFIG, bare).queryIds("SELECT 1"), []);
});

test("a non-success status and an undecodable body are distinguishable remote failures", async () => {
  const { transport: failing } = recordingTransport([{ status: 503, body: "" }]);
  await assert.rejects(
    () => new AdoClient(CONFIG, failing).queryIds("SELECT 1"),
    (error: unknown) => error instanceof CommandError && error.exitCode === EXIT_CODE.remote && /503/u.test(error.message),
  );

  const { transport: garbled } = recordingTransport([{ status: 200, body: "<html>not json</html>" }]);
  await assert.rejects(
    () => new AdoClient(CONFIG, garbled).queryIds("SELECT 1"),
    (error: unknown) => error instanceof CommandError && error.exitCode === EXIT_CODE.remote && /not JSON/u.test(error.message),
  );
});

test("a request without a body sends no content type and encodes the project", async () => {
  const { transport, calls } = recordingTransport([{ status: 200, body: "{}" }]);
  await new AdoClient({ ...CONFIG, project: "a b/c" }, transport).request("GET", "/_apis/wit/x");
  assert.equal(calls[0]!.body, undefined);
  assert.equal(calls[0]!.headers["Content-Type"], undefined);
  assert.match(calls[0]!.url, /a%20b%2Fc/u);
});

test("typed relations map to pm kinds, and an unmapped edge is reported not dropped", () => {
  const item: AdoWorkItem = {
    id: 1,
    rev: 1,
    fields: {},
    relations: [
      { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://x/_apis/wit/workItems/12" },
      { rel: "System.LinkTypes.Related", url: "https://x/_apis/wit/workItems/34" },
      { rel: "AttachedFile", url: "https://x/_apis/wit/attachments/abc" },
      { rel: "System.LinkTypes.Related", url: "https://x/_apis/wit/workItems/not-an-id" },
    ],
  };
  const { links, unmapped } = mapRelations(item, "https://x");
  assert.deepEqual(links, [
    { kind: "parent", targetId: 12 },
    { kind: "related", targetId: 34 },
  ]);
  // Both the unknown relation kind and the non-item URL are surfaced, so an
  // import cannot look complete while silently discarding edges.
  assert.deepEqual(unmapped, ["AttachedFile", "System.LinkTypes.Related"]);

  assert.deepEqual(mapRelations({ id: 2, rev: 1, fields: {} }, "https://x"), { links: [], unmapped: [] });
  // Hierarchy-Reverse is the PARENT end; getting this backwards inverts a tree.
  assert.equal(RELATION_MAP["System.LinkTypes.Hierarchy-Reverse"], "parent");
  assert.equal(STATE_MAP.in_progress, "Active");
});

test("relation targets must identify a safe work item in the configured organization", () => {
  const org = "https://dev.azure.com/contoso";
  assert.equal(relationTargetId("https://dev.azure.com/contoso/_apis/wit/workItems/7", org), 7);
  assert.equal(relationTargetId("https://dev.azure.com/contoso/_apis/wit/workItems/9007199254740991", org), Number.MAX_SAFE_INTEGER);
  for (const url of [
    "7",
    "",
    "https://dev.azure.com/other/_apis/wit/workItems/7",
    "https://evil.example/contoso/_apis/wit/workItems/7",
    "https://dev.azure.com/contoso/_apis/wit/attachments/7",
    "https://dev.azure.com/contoso/_apis/wit/workItems/9007199254740993",
    "https://dev.azure.com/contoso/_apis/wit/workItems/0",
    "https://dev.azure.com/contoso/_apis/wit/workItems/-3",
    "https://dev.azure.com/contoso/_apis/wit/workItems/7?api-version=7.1",
    "https://dev.azure.com/contoso/_apis/wit/workItems/7#other",
    // WHATWG parsing leaves search and hash empty for a bare delimiter, so
    // the raw URL has to be rejected or these would map as local links.
    "https://dev.azure.com/contoso/_apis/wit/workItems/7?",
    "https://dev.azure.com/contoso/_apis/wit/workItems/7#",
    "https://dev.azure.com/contoso/_apis/wit/workItems/7?#",
    "https://user:secret@dev.azure.com/contoso/_apis/wit/workItems/7",
    "https:///dev.azure.com/contoso/_apis/wit/workItems/7",
    "https://dev.azure.com/other/../contoso/_apis/wit/workItems/7",
    "https://dev.azure.com/other/%2e%2e/contoso/_apis/wit/workItems/7",
  ]) assert.equal(relationTargetId(url, org), undefined, url);
  const omittedTargetOrg = relationTargetId as (url: string, orgUrl?: string) => number | undefined;
  assert.throws(() => omittedTargetOrg("https://dev.azure.com/contoso/_apis/wit/workItems/7"), {
    name: "TypeError",
    message: "relationTargetId requires orgUrl",
  });
  const mapped = mapRelations({
    id: 1,
    rev: 1,
    fields: {},
    relations: [
      { rel: "System.LinkTypes.Related", url: "https://dev.azure.com/other/_apis/wit/workItems/7" },
      { rel: "System.LinkTypes.Related", url: "https://dev.azure.com/contoso/_apis/wit/workItems/9007199254740993" },
      { rel: "System.LinkTypes.Related", url: "https://dev.azure.com/contoso/_apis/wit/workItems/8" },
    ],
  }, org);
  assert.deepEqual(mapped, {
    links: [{ kind: "related", targetId: 8 }],
    unmapped: ["System.LinkTypes.Related", "System.LinkTypes.Related"],
  });
  // A JavaScript caller can omit the new required argument. That must fail
  // explicitly instead of parking every valid relation in unmapped.
  const omittedOrg = mapRelations as (item: AdoWorkItem, orgUrl?: string) => ReturnType<typeof mapRelations>;
  assert.throws(() => omittedOrg({
    id: 1,
    rev: 1,
    fields: {},
    relations: [{ rel: "System.LinkTypes.Related", url: "https://dev.azure.com/contoso/_apis/wit/workItems/8" }],
  }), {
    name: "TypeError",
    message: "mapRelations requires orgUrl",
  });
});

test("configuration is read whole or not at all, and the org URL is normalised", () => {
  assert.deepEqual(readConfig({ ADO_ORG_URL: "https://dev.azure.com/c/", ADO_PROJECT: "P", ADO_TOKEN: "t" }), {
    orgUrl: "https://dev.azure.com/c",
    project: "P",
    token: "t",
  });
  // Multiple trailing slashes and an all-slash URL exercise the backward scan
  // to completion (end reaches 0) and the no-trailing-slash early exit.
  assert.deepEqual(readConfig({ ADO_ORG_URL: "https://dev.azure.com/c///", ADO_PROJECT: "P", ADO_TOKEN: "t" }), {
    orgUrl: "https://dev.azure.com/c",
    project: "P",
    token: "t",
  });
  assert.deepEqual(readConfig({ ADO_ORG_URL: "a/", ADO_PROJECT: "P", ADO_TOKEN: "t" }), {
    orgUrl: "a",
    project: "P",
    token: "t",
  });
  assert.equal(readConfig({ ADO_ORG_URL: "https://x", ADO_PROJECT: "P" }), undefined);
  assert.equal(readConfig({ ADO_ORG_URL: "  ", ADO_PROJECT: "P", ADO_TOKEN: "t" }), undefined);
  assert.deepEqual(missingEnv({ ADO_PROJECT: "P" }), ["ADO_ORG_URL", "ADO_TOKEN"]);
  assert.deepEqual(missingEnv({ ADO_ORG_URL: "a", ADO_PROJECT: "b", ADO_TOKEN: "c" }), []);
});

test("readConfig strips a ReDoS-adversarial org URL within a hard time bound", () => {
  // Adversarial witness for the polynomial-redos path: a long run of slashes,
  // a single non-slash, then a long run of trailing slashes. The old regex
  // /\/+$/u backtracks O(n²) on this shape because the engine tries to anchor
  // `$` from every slash position in the first run, backtracking the greedy
  // `+` quantifier at each one before it reaches the match at the end. The
  // backward scan is O(n) and completes in microseconds.
  //
  // 100 001 characters: 50 000 slashes + "a" + 50 000 slashes.
  const slashes = "/".repeat(50000);
  const adversarial = slashes + "a" + slashes;
  assert.equal(adversarial.length, 100001);
  const start = performance.now();
  const config = readConfig({
    ADO_ORG_URL: adversarial,
    ADO_PROJECT: "P",
    ADO_TOKEN: "t",
  });
  const elapsed = performance.now() - start;
  assert.ok(
    elapsed < 50,
    `readConfig took ${elapsed.toFixed(1)}ms on a ${adversarial.length}-character adversarial URL — expected < 50ms`,
  );
  assert.equal(config?.orgUrl, slashes + "a");
});

test("the credential preflight fires only where a command would reach the network", () => {
  const bare = {};
  const full = { ADO_ORG_URL: "a", ADO_PROJECT: "b", ADO_TOKEN: "c" };
  // Offline diagnostics and dry runs stay usable when credentials are exactly
  // what is missing - that is the situation they exist for.
  assert.equal(shouldFailFast("ado validate", {}, bare), false);
  assert.equal(shouldFailFast("ado sync", { dryRun: true }, bare), false);
  assert.equal(shouldFailFast("ado sync", {}, full), false);
  assert.equal(shouldFailFast("ado sync", {}, bare), true);
  assert.ok(MUTATING_COMMANDS.includes("ado sync"));
});

test("the preflight message names the missing variables and never the token", () => {
  const one = preflightMessage("ado sync", ["ADO_TOKEN"]);
  assert.match(one, /one is missing: ADO_TOKEN/u);
  const many = preflightMessage("ado sync", ["ADO_ORG_URL", "ADO_TOKEN"]);
  assert.match(many, /2 are missing/u);
  assert.match(many, /pm ado validate/u);
});

test("CommandError carries the exit code pm's runtime needs to exit cleanly once", () => {
  // Without a numeric exitCode pm falls through to its unhandled path, which
  // re-invokes the handler and doubles any side effect already performed.
  assert.equal(new CommandError("x").exitCode, EXIT_CODE.usage);
  assert.equal(new CommandError("x", EXIT_CODE.remote).exitCode, EXIT_CODE.remote);
  assert.equal(new CommandError("x").name, "CommandError");
});

let harness: ExtensionTestHarness | undefined;

/** Activate the extension once through pm's real engine and reuse it. */
async function getHarness(): Promise<ExtensionTestHarness> {
  if (!harness) {
    harness = await createExtensionTestHarness(extension, {
      name: "pm-ado",
      capabilities: ["commands", "schema", "importers", "hooks", "preflight"],
    });
    assert.deepEqual(harness.activation.failed, [], "activation must not fail");
  }
  return harness;
}

test("the extension activates against pm's real registration engine", async () => {
  const active = await getHarness();
  assert.equal(extension.name, "pm-ado");
  assert.deepEqual(active.activation.failed, []);
});

test("ado validate reports readiness without leaking the token", async () => {
  const active = await getHarness();
  const before = { ...process.env };
  try {
    delete process.env.ADO_ORG_URL;
    delete process.env.ADO_PROJECT;
    delete process.env.ADO_TOKEN;
    const missing = await active.runCommand({ command: "ado validate" });
    const payload = (missing as unknown as { result: Record<string, unknown> }).result;
    assert.equal(payload.ok, false);
    assert.equal(payload.token_present, false);

    process.env.ADO_ORG_URL = "https://dev.azure.com/c";
    process.env.ADO_PROJECT = "P";
    process.env.ADO_TOKEN = "super-secret";
    const ready = await active.runCommand({ command: "ado validate" });
    const readyPayload = (ready as unknown as { result: Record<string, unknown> }).result;
    assert.equal(readyPayload.ok, true);
    assert.equal(readyPayload.token_present, true);
    assert.equal(readyPayload.writes_assert_revision, true);
    // The token value itself must appear nowhere in the payload.
    assert.equal(JSON.stringify(readyPayload).includes("super-secret"), false);
  } finally {
    for (const key of ["ADO_ORG_URL", "ADO_PROJECT", "ADO_TOKEN"]) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});

test("every request carries the token as a basic credential with an empty username", async () => {
  // Azure DevOps expects a personal access token as the PASSWORD of a basic
  // credential whose username is empty. Getting this wrong authenticates
  // nothing, and the failure surfaces only against the real service.
  const { transport, calls } = recordingTransport([{ status: 200, body: "{}" }]);
  await new AdoClient(CONFIG, transport).request("GET", "/_apis/wit/x");
  const authorization = calls[0]!.headers.Authorization!;
  assert.match(authorization, /^Basic /u);
  assert.equal(Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf-8"), ":pat");
  assert.equal(calls[0]!.headers.Accept, "application/json");
});

test("the credential preflight refuses before the command runs, and passes otherwise", () => {
  const written: string[] = [];
  const exits: number[] = [];
  const exit = ((code: number) => {
    exits.push(code);
    // Real `process.exit` never returns; the test double must not either, or
    // the code under test would continue past a refusal it believes is final.
    throw new Error("exited");
  }) as (code: number) => never;

  // Refusal: a network-bound command with no credentials.
  assert.throws(
    () => runCredentialPreflight({ command: "ado sync", options: {} } as never, {}, (m) => written.push(String(m)), exit),
    /exited/u,
  );
  assert.deepEqual(exits, [EXIT_CODE.usage]);
  assert.match(written[0]!, /ADO_ORG_URL/u);
  // The message must not be able to leak a value it never received.
  assert.equal(written[0]!.includes("undefined"), false);

  // Pass-through: credentials present.
  const ok = runCredentialPreflight(
    { command: "ado sync", options: {} } as never,
    { ADO_ORG_URL: "a", ADO_PROJECT: "b", ADO_TOKEN: "c" },
    (m) => written.push(String(m)),
    exit,
  );
  assert.deepEqual(ok, {});

  // Pass-through: a command that never reaches the network, with no context.
  assert.deepEqual(runCredentialPreflight({} as never, {}, (m) => written.push(String(m)), exit), {});
  assert.equal(exits.length, 1);
});

test("the registered preflight is reachable through pm's own preflight runtime", async () => {
  // Exercises the registration wiring itself, not just the extracted decision:
  // the override is looked up and invoked by pm's runtime exactly as it would
  // be in a real command. Credentials are set so the pass-through path runs -
  // the refusal path ends the process, which is why its logic is tested through
  // runCredentialPreflight with an injected exit rather than here.
  const active = await getHarness();
  const before = { ...process.env };
  try {
    process.env.ADO_ORG_URL = "https://dev.azure.com/c";
    process.env.ADO_PROJECT = "P";
    process.env.ADO_TOKEN = "t";
    const decision = await active.runPreflightOverride({ command: "ado sync", options: {} } as never);
    assert.ok(decision, "the runtime must return a decision for a registered preflight");
  } finally {
    for (const key of ["ADO_ORG_URL", "ADO_PROJECT", "ADO_TOKEN"]) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});

test("an informational status is a remote failure too, not a success below the range", async () => {
  // The success test is a range, not `>= 300`. A 1xx reaching this layer means
  // the request did not complete, and treating it as success would parse an
  // empty body as a work item.
  const { transport } = recordingTransport([{ status: 100, body: "" }]);
  await assert.rejects(
    () => new AdoClient(CONFIG, transport).queryIds("SELECT 1"),
    (error: unknown) => error instanceof CommandError && error.exitCode === EXIT_CODE.remote,
  );
});

test("a token of only whitespace is reported as absent, not as present", async () => {
  const active = await getHarness();
  const before = process.env.ADO_TOKEN;
  try {
    process.env.ADO_TOKEN = "   ";
    const result = await active.runCommand({ command: "ado validate" });
    const payload = (result as unknown as { result: Record<string, unknown> }).result;
    assert.equal(payload.token_present, false, "a blank token must not read as configured");
    assert.ok((payload.missing as string[]).includes("ADO_TOKEN"));
  } finally {
    if (before === undefined) delete process.env.ADO_TOKEN;
    else process.env.ADO_TOKEN = before;
  }
});

test("a patch that does not assert a revision is refused before it reaches the network", async () => {
  // The invariant guards the transport, not one call site, so it holds for any
  // future patch path. Reachable precisely because it lives here: sending an
  // unchecked patch directly is the only way to violate it, and it is refused.
  const { transport, calls } = recordingTransport([{ status: 200, body: "{}" }]);
  const client = new AdoClient(CONFIG, transport);
  await assert.rejects(
    () => client.request("PATCH", "/_apis/wit/workitems/1", [{ op: "replace", path: "/fields/System.Title", value: "x" }], PATCH_MEDIA_TYPE),
    (error: unknown) => error instanceof CommandError && error.exitCode === EXIT_CODE.usage,
  );
  // A non-array body is refused the same way rather than being coerced.
  await assert.rejects(
    () => client.request("PATCH", "/_apis/wit/workitems/1", { op: "test" }, PATCH_MEDIA_TYPE),
    (error: unknown) => error instanceof CommandError && error.exitCode === EXIT_CODE.usage,
  );
  assert.equal(calls.length, 0, "nothing may reach the network before the invariant is satisfied");

  // A well-formed patch passes.
  await client.request("PATCH", "/_apis/wit/workitems/1", buildUpdatePatch(2, { "System.Title": "x" }), PATCH_MEDIA_TYPE);
  assert.equal(calls.length, 1);
});

/** Initialize a disposable, real SDK tracker with stable remote identity correspondence. */
async function relationTracker(t: test.TestContext, count = 6) {
  const root = mkdtempSync(join(tmpdir(), "ado-relations-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pmRoot = join(root, ".agents/pm");
  const pm = new PmClient({ cwd: root, pmRoot, noExtensions: true, author: "fixture-agent" });
  await pm.run("init", { prefix: "fixture" });
  const identities = new Map<number, string>();
  for (let id = 1; id <= count; id++) {
    const { item } = await pm.create({ title: `Work item ${id}`, type: "Task" });
    identities.set(id, item.id);
  }
  return { pm, pmRoot, identities, ids: [...identities.values()] };
}

/** A relation-aware HTTP fixture evaluating revision tests before applying a whole patch. */
function relationService(initial: readonly AdoWorkItem[]) {
  const items = new Map(initial.map((item) => [item.id, structuredClone(item)]));
  const patches: JsonPatchOperation[][] = [];
  const transport: AdoTransport = async (method, _url, body) => {
    if (method === "POST") {
      const request = JSON.parse(body!) as { ids: number[]; $expand: string };
      assert.equal(request.$expand, "relations");
      return { status: 200, body: JSON.stringify({ value: request.ids.flatMap((id) => items.has(id) ? [items.get(id)] : []) }) };
    }
    assert.equal(method, "PATCH");
    const id = Number(new URL(_url).pathname.split("/").at(-1));
    const current = items.get(id)!;
    const patch = JSON.parse(body!) as JsonPatchOperation[];
    patches.push(patch);
    if (patch[0]!.value !== current.rev) return { status: 412, body: "" };
    const next = structuredClone(current);
    const relations = [...next.relations!];
    for (const op of patch.slice(1)) {
      if (op.path === "/relations/-") relations.push(op.value as AdoRelation);
      else if (op.op === "remove") relations.splice(Number(op.path.split("/").at(-1)), 1);
      else next.fields[op.path.slice("/fields/".length)] = op.value;
    }
    next.relations = relations;
    next.rev++;
    items.set(id, next);
    return { status: 200, body: JSON.stringify(next) };
  };
  return { transport, patches, items };
}

/** Construct canonical synthetic work-item relations without contacting a service. */
function edge(rel: string, id: number): AdoRelation {
  return { rel, url: `${CONFIG.orgUrl}/_apis/wit/workItems/${id}` };
}

for (const implementation of [
  { name: "source", importRelations, exportRelations, AdoClient, CommandError },
  { name: "built", importRelations: built.importRelations, exportRelations: built.exportRelations, AdoClient: built.AdoClient, CommandError: built.CommandError },
]) {
  test(`${implementation.name}: typed relations round-trip through a real tracker and HTTP fixtures idempotently`, async (t) => {
    const { pm, identities, ids, pmRoot } = await relationTracker(t);
    const custom = { "Custom.Supports": "verifies" as const, "Custom.Association": "related" as const };
    const original: AdoWorkItem[] = [
      { id: 1, rev: 7, fields: {}, relations: [edge("System.LinkTypes.Hierarchy-Forward", 2), edge("System.LinkTypes.Dependency-Forward", 3), edge("System.LinkTypes.Related", 4), edge("System.LinkTypes.Duplicate-Forward", 4), edge("Custom.Supports", 5), edge("Custom.Association", 4)] },
      { id: 2, rev: 1, fields: {}, relations: [edge("System.LinkTypes.Hierarchy-Reverse", 1)] },
      { id: 3, rev: 1, fields: {}, relations: [edge("System.LinkTypes.Dependency-Reverse", 1)] },
      { id: 4, rev: 1, fields: {}, relations: [edge("System.LinkTypes.Related", 1), edge("System.LinkTypes.Duplicate-Reverse", 1), edge("Custom.Association", 1)] },
      { id: 5, rev: 1, fields: {}, relations: [] },
      { id: 6, rev: 1, fields: {}, relations: [{ rel: "Unknown.Type", url: "https://fixture.invalid/opaque", attributes: { comment: "keep me" } }, edge("System.LinkTypes.Related", 99)] },
    ];
    const fixture = relationService(original);
    const client = new implementation.AdoClient(CONFIG, fixture.transport);
    const remote = await client.getWorkItems([...identities.keys()]);
    const first = await implementation.importRelations(remote, CONFIG.orgUrl, identities, pm, custom);
    assert.equal(first.updated.length, 4);
    assert.equal(first.unmapped.length, 2);
    const rows = (await pm.listAllComplete()).items;
    assert.equal(rows.find((row) => row.id === ids[1])!.parent, ids[0]);
    const deps = rows.find((row) => row.id === ids[0])!.dependencies!;
    assert.deepEqual(deps.map((dep) => JSON.stringify([dep.id, dep.kind, dep.source_kind])).sort(), [
      [ids[2], "blocks", "System.LinkTypes.Dependency-Forward"],
      [ids[3], "related", "System.LinkTypes.Related"],
      [ids[3], "related", "System.LinkTypes.Duplicate-Forward"],
      [ids[4], "verifies", "Custom.Supports"],
      [ids[3], "related", "Custom.Association"],
    ].map((dep) => JSON.stringify(dep)).sort());
    const history = readFileSync(join(pmRoot, "history", `${ids[0]}.jsonl`), "utf8");
    assert.deepEqual((await implementation.importRelations(remote, CONFIG.orgUrl, identities, pm, custom)).updated, []);
    assert.equal(readFileSync(join(pmRoot, "history", `${ids[0]}.jsonl`), "utf8"), history);
    for (const item of remote) {
      const plan = await implementation.exportRelations(item, CONFIG.orgUrl, identities, pm, custom);
      assert.deepEqual(plan.operations, [], `unchanged item ${item.id} must need no PATCH`);
      assert.equal(plan.unmappedLocal.length, 0);
    }
    assert.equal(fixture.patches.length, 0);
    // A locally authored dependency must export both ends, then import without duplication.
    await pm.update(ids[0]!, { dep: [`id=${ids[5]},kind=blocks`] });
    for (const id of [1, 6]) {
      const snapshot = fixture.items.get(id)!;
      const plan = await implementation.exportRelations(snapshot, CONFIG.orgUrl, identities, pm, custom);
      assert.equal(plan.operations.length, 1);
      const written = await client.updateWorkItem(id, snapshot.rev, {}, plan.operations);
      assert.deepEqual(fixture.patches.at(-1)![0], { op: "test", path: "/rev", value: snapshot.rev });
      assert.deepEqual((await implementation.exportRelations(written, CONFIG.orgUrl, identities, pm, custom)).operations, []);
    }
    assert.deepEqual(fixture.items.get(6)!.relations!.slice(0, 2), original[5]!.relations);
    await implementation.importRelations(await client.getWorkItems([1, 6]), CONFIG.orgUrl, identities, pm, custom);
    const afterImport = (await pm.listAllComplete()).items.find((row) => row.id === ids[0])!.dependencies!;
    assert.equal(afterImport.filter((dep) => dep.id === ids[5] && dep.kind === "blocks").length, 1);
  });

  test(`${implementation.name}: parent update failure restores hierarchy without leaving items detached`, async (t) => {
    for (const failAt of [2, 1, 3, 4, 5]) {
      const { pm, identities, ids } = await relationTracker(t);
      await pm.update(ids[1]!, { parent: ids[0] });
      await pm.update(ids[2]!, { parent: ids[1] });
      await pm.update(ids[4]!, { parent: ids[0] });
      const before = new Map((await pm.listAllComplete()).items.map((item) => [item.id, item.parent]));
      const update = pm.update.bind(pm);
      const failure = new Error(`injected update ${failAt}`);
      let calls = 0;
      let failed = false;
      const forwardUnsets: string[] = [];
      pm.update = async (id, options) => {
        if (!failed && options?.unset?.includes("parent")) forwardUnsets.push(id);
        if (++calls === failAt) {
          failed = true;
          throw failure;
        }
        return update(id, options);
      };
      await assert.rejects(() => implementation.importRelations([
        { id: 1, rev: 1, fields: {}, relations: [edge("System.LinkTypes.Hierarchy-Reverse", 2)] },
        { id: 2, rev: 1, fields: {}, relations: [edge("System.LinkTypes.Hierarchy-Reverse", 3)] },
        { id: 3, rev: 1, fields: {}, relations: [edge("System.LinkTypes.Hierarchy-Reverse", 4)] },
        { id: 5, rev: 1, fields: {}, relations: [edge("System.LinkTypes.Hierarchy-Reverse", 6)] },
        { id: 6, rev: 1, fields: {}, relations: [edge("System.LinkTypes.Related", 4)] },
      ], CONFIG.orgUrl, identities, pm), (error: unknown) => error === failure);
      assert.deepEqual(new Map((await pm.listAllComplete()).items.map((item) => [item.id, item.parent])), before,
        `update ${failAt}: every previous parent must be restored`);
      assert.deepEqual(forwardUnsets, [], "final-tree ordering requires no transient detachment");
    }
  });

  test(`${implementation.name}: failed parent compensation reports exact detached IDs and continues recovery`, async (t) => {
    for (const detach of [false, true]) {
      const { pm, identities, ids } = await relationTracker(t, 4);
      await pm.update(ids[1]!, { parent: ids[0] });
      const update = pm.update.bind(pm);
      const failure = new Error("injected batch failure");
      const forwardParents: string[] = [];
      let failed = false;
      pm.update = async (id, options) => {
        if (!failed && options?.parent !== undefined) {
          forwardParents.push(id);
          if (forwardParents.length === 3) {
            failed = true;
            throw failure;
          }
        } else if (failed && id === ids[1]) {
          if (detach) await update(id, { unset: ["parent"] });
          throw new Error("injected restoration failure");
        }
        return update(id, options);
      };
      await assert.rejects(() => implementation.importRelations([
        { id: 1, rev: 1, fields: {}, relations: [edge("System.LinkTypes.Hierarchy-Reverse", 2)] },
        { id: 2, rev: 1, fields: {}, relations: [edge("System.LinkTypes.Hierarchy-Reverse", 3)] },
        { id: 4, rev: 1, fields: {}, relations: [edge("System.LinkTypes.Hierarchy-Reverse", 1)] },
      ], CONFIG.orgUrl, identities, pm), (error: unknown) => {
        assert.ok(error instanceof implementation.CommandError);
        assert.equal(error.exitCode, EXIT_CODE.conflict);
        assert.equal(error.cause, failure);
        assert.equal(error.message, `Error: injected batch failure; parent restoration failed for: ${ids[1]}; detached IDs: ${detach ? ids[1] : "none"}`);
        return true;
      });
      const rows = (await pm.listAllComplete()).items;
      assert.equal(rows.find((item) => item.id === ids[0])!.parent, undefined,
        "compensation must continue restoring other completed changes");
      assert.equal(rows.find((item) => item.id === ids[1])!.parent, detach ? undefined : ids[2]);
    }
  });

  test(`${implementation.name}: ambiguous custom inverse pairs retain provenance without guessing`, async (t) => {
    const { pm, identities, ids } = await relationTracker(t, 3);
    const custom = {
      "Custom.Before": "blocks" as const, "Custom.After": "blocked_by" as const,
      "Custom.Precedes": "blocks" as const, "Custom.Follows": "blocked_by" as const,
    };
    await implementation.importRelations([
      { id: 1, rev: 1, fields: {}, relations: [edge("Custom.Precedes", 2)] },
      { id: 2, rev: 1, fields: {}, relations: [edge("Custom.Follows", 3)] },
    ], CONFIG.orgUrl, identities, pm, custom);
    const reverse = await implementation.exportRelations({ id: 2, rev: 1, fields: {}, relations: [] }, CONFIG.orgUrl, identities, pm, custom);
    assert.deepEqual(reverse.operations, [{ op: "add", path: "/relations/-", value: edge("Custom.Follows", 3) }]);
    assert.deepEqual(reverse.unmappedLocal, [{ id: ids[1], kind: "blocked_by", target: ids[0], source_kind: "Custom.Precedes" }]);
    const retained = { ...edge("Custom.Follows", 1), attributes: { comment: "keep ambiguous inverse" } };
    const existing = await implementation.exportRelations({ id: 2, rev: 1, fields: {}, relations: [retained] }, CONFIG.orgUrl, identities, pm, custom);
    assert.deepEqual(existing.operations, reverse.operations, "unresolved inverse must not remove an existing remote link");
    assert.deepEqual(existing.unmapped, [{ itemId: 2, relation: retained }]);
    const forward = await implementation.exportRelations({ id: 3, rev: 1, fields: {}, relations: [] }, CONFIG.orgUrl, identities, pm, custom);
    assert.deepEqual(forward.operations, []);
    assert.deepEqual(forward.unmappedLocal, [{ id: ids[2], kind: "blocks", target: ids[1], source_kind: "Custom.Follows" }]);
    const fallback = await implementation.exportRelations({ id: 2, rev: 1, fields: {}, relations: [] }, CONFIG.orgUrl, identities, pm,
      { "Custom.Precedes": "blocks", "Custom.Follows": "blocked_by", "Custom.Before": "blocks" });
    assert.deepEqual(fallback.operations.map((op) => (op.value as AdoRelation).rel), ["Custom.Follows", "Custom.Follows"]);
    const builtin = await implementation.exportRelations({ id: 2, rev: 1, fields: {}, relations: [] }, CONFIG.orgUrl, identities, pm,
      { "Custom.Precedes": "blocks" });
    assert.deepEqual(builtin.operations, [{ op: "add", path: "/relations/-", value: edge("System.LinkTypes.Dependency-Reverse", 1) }]);
  });

  test(`${implementation.name}: hierarchy cycles and competing remote parents leave tracker history untouched`, async (t) => {
    const { pm, identities, ids, pmRoot } = await relationTracker(t);
    await pm.update(ids[1]!, { parent: ids[0] });
    await pm.update(ids[2]!, { dep: [`id=${ids[1]},kind=parent`] });
    const before = await pm.listAllComplete();
    const histories = ids.map((id) => readFileSync(join(pmRoot, "history", `${id}.jsonl`), "utf8"));
    for (const snapshots of [
      [{ id: 1, rev: 1, fields: {}, relations: [edge("System.LinkTypes.Hierarchy-Reverse", 3)] }],
      [{ id: 4, rev: 1, fields: {}, relations: [edge("System.LinkTypes.Hierarchy-Reverse", 4)] }],
      [{ id: 4, rev: 1, fields: {}, relations: [edge("System.LinkTypes.Hierarchy-Reverse", 5), edge("System.LinkTypes.Hierarchy-Forward", 5)] }],
      [{ id: 4, rev: 1, fields: {}, relations: [edge("System.LinkTypes.Hierarchy-Reverse", 5), edge("System.LinkTypes.Hierarchy-Reverse", 6)] }],
    ]) {
      await assert.rejects(() => implementation.importRelations(snapshots, CONFIG.orgUrl, identities, pm), /cycle|conflicting remote parents/u);
      assert.deepEqual((await pm.listAllComplete()).items, before.items);
      assert.deepEqual(ids.map((id) => readFileSync(join(pmRoot, "history", `${id}.jsonl`), "utf8")), histories);
    }
  });
}

test("duplicate mapping, custom reference validation and prototype names are safe", () => {
  const relation = edge("System.LinkTypes.Related", 2);
  assert.equal(mapRelations({ id: 1, rev: 1, fields: {}, relations: [relation, relation] }, CONFIG.orgUrl).links.length, 1);
  assert.deepEqual(mapRelations({ id: 1, rev: 1, fields: {}, relations: [edge("toString", 2)] }, CONFIG.orgUrl).unmapped, ["toString"]);
  assert.deepEqual(mapRelations({ id: 1, rev: 1, fields: {}, relations: [edge("Custom.Supports", 2)] }, CONFIG.orgUrl, { "Custom.Supports": "verifies" }).links, [{ kind: "verifies", targetId: 2 }]);
  for (const rel of ["System.LinkTypes.Related", "Custom.Bad,kind=blocks"]) {
    assert.throws(() => mapRelations({ id: 1, rev: 1, fields: {}, relations: [edge(rel, 2)] }, CONFIG.orgUrl, { [rel]: "related" }), /invalid custom/u);
  }
});

test("relation patch guards reject attempts to smuggle fields or revision changes", () => {
  for (const operation of [
    { op: "test" as const, path: "/rev", value: 2 },
    { op: "replace" as const, path: "/fields/System.Title", value: "oops" },
    { op: "remove" as const, path: "/relations/-1" },
    { op: "add" as const, path: "/relations/0" },
  ]) assert.throws(() => buildUpdatePatch(1, {}, [operation]), /relation changes/u);
});

test("reparenting a valid final tree avoids transient cycles and preserves independent dependencies", async (t) => {
  const { pm, identities, ids } = await relationTracker(t, 3);
  await pm.update(ids[1]!, { parent: ids[0], dep: [`id=${ids[2]},kind=implements`] });
  const report = await importRelations([
    { id: 1, rev: 1, fields: {}, relations: [edge("System.LinkTypes.Hierarchy-Reverse", 2)] },
    { id: 2, rev: 1, fields: {}, relations: [edge("System.LinkTypes.Hierarchy-Reverse", 3)] },
  ], CONFIG.orgUrl, identities, pm);
  assert.equal(report.updated.length, 2);
  const rows = (await pm.listAllComplete()).items;
  assert.equal(rows.find((item) => item.id === ids[0])!.parent, ids[1]);
  assert.equal(rows.find((item) => item.id === ids[1])!.parent, ids[2]);
  assert.equal(rows.find((item) => item.id === ids[1])!.dependencies![0]!.kind, "implements");
  assert.deepEqual((await importRelations([{ id: 3, rev: 1, fields: {} }], CONFIG.orgUrl, identities, pm)).updated, []);
});

test("relation planning rejects invalid identities, missing sources, and unexpanded exports", async (t) => {
  const { pm, identities, ids } = await relationTracker(t, 2);
  const remote = { id: 1, rev: 1, fields: {}, relations: [] };
  for (const bad of [
    new Map([[0, ids[0]!]]),
    new Map([[Number.MAX_SAFE_INTEGER + 1, ids[0]!]]),
    new Map([[1, "fixture-missing"]]),
    new Map([[1, ids[0]!], [2, ids[0]!]]),
  ]) {
    await assert.rejects(() => importRelations([remote], CONFIG.orgUrl, bad, pm), /unique safe IDs/u);
    await assert.rejects(() => exportRelations(remote, CONFIG.orgUrl, bad, pm), /unique safe IDs/u);
  }
  await assert.rejects(() => importRelations([{ ...remote, id: 99 }], CONFIG.orgUrl, identities, pm), /missing pm identity/u);
  await assert.rejects(() => exportRelations({ ...remote, id: 99 }, CONFIG.orgUrl, identities, pm), /missing pm identity/u);
  await assert.rejects(() => exportRelations({ id: 1, rev: 1, fields: {} }, CONFIG.orgUrl, identities, pm), /expanded/u);
  await pm.update(ids[0]!, { dep: [`id=${ids[1]},kind=related`] });
  await assert.rejects(() => exportRelations(remote, "https://token@fixture.invalid/org", identities, pm), /canonical organization/u);
  const unsafe: AdoRelation = { rel: "System.LinkTypes.Related", url: "https://fixture.invalid/other/_apis/wit/workItems/2" };
  assert.deepEqual((await importRelations([{ ...remote, relations: [unsafe] }], CONFIG.orgUrl, identities, pm)).unmapped, [{ itemId: 1, relation: unsafe }]);
  assert.equal((await exportRelations({ ...remote, relations: [unsafe] }, CONFIG.orgUrl, identities, pm)).unmapped.length, 1);
});

test("export removes stale and duplicate entries by descending index and preserves surviving annotations", async (t) => {
  const { pm, identities, ids } = await relationTracker(t, 3);
  await pm.update(ids[0]!, { dep: [`id=${ids[1]},kind=related`] });
  const retained = { ...edge("System.LinkTypes.Related", 2), attributes: { comment: "retained annotation" } };
  const remote: AdoWorkItem = { id: 1, rev: 5, fields: {}, relations: [retained, edge("System.LinkTypes.Related", 3), retained, edge("System.LinkTypes.Dependency-Forward", 3)] };
  const service = relationService([remote]);
  const plan = await exportRelations(remote, CONFIG.orgUrl, identities, pm);
  assert.deepEqual(plan.operations, [3, 2, 1].map((index) => ({ op: "remove", path: `/relations/${index}` })));
  const client = new AdoClient(CONFIG, service.transport);
  const updated = await client.updateWorkItem(1, 5, { "System.Title": "with relations" }, plan.operations);
  assert.deepEqual(updated.relations, [retained]);
  assert.equal(updated.fields["System.Title"], "with relations");
  assert.deepEqual((await exportRelations(updated, CONFIG.orgUrl, identities, pm)).operations, []);
  await assert.rejects(() => client.updateWorkItem(1, 5, {}, [{ op: "remove", path: "/relations/0" }]), /asserted rev 5 but current rev is 6/u);
  assert.deepEqual(service.items.get(1)!.relations, [retained]);
  assert.equal(service.patches.length, 2, "conflict must not replay the write");
});

test("custom hierarchy names survive without dropping distinct reference types", async (t) => {
  const { pm, identities, ids } = await relationTracker(t, 2);
  const custom = { "Custom.Parent": "parent" as const, "Custom.Child": "child" as const };
  await importRelations([{ id: 2, rev: 1, fields: {}, relations: [edge("Custom.Parent", 1), edge("Custom.Parent", 1)] }], CONFIG.orgUrl, identities, pm, custom);
  assert.equal((await pm.listAllComplete()).items.find((item) => item.id === ids[1])!.parent, ids[0]);
  const parentRemote = { id: 2, rev: 1, fields: {}, relations: [edge("Custom.Parent", 1)] };
  assert.deepEqual((await exportRelations(parentRemote, CONFIG.orgUrl, identities, pm, custom)).operations, []);
  const childRemote = { id: 1, rev: 1, fields: {}, relations: [edge("Custom.Child", 2)] };
  assert.deepEqual((await exportRelations(childRemote, CONFIG.orgUrl, identities, pm, custom)).operations, []);
  for (const relations of [
    [edge("Custom.Child", 2), edge("System.LinkTypes.Hierarchy-Forward", 2)],
    [edge("System.LinkTypes.Hierarchy-Forward", 2), edge("Custom.Child", 2)],
  ]) {
    assert.deepEqual((await exportRelations({ ...childRemote, relations }, CONFIG.orgUrl, identities, pm, custom)).operations, []);
    assert.deepEqual((await exportRelations({ ...childRemote, relations: [...relations, relations[0]!] }, CONFIG.orgUrl, identities, pm, custom)).operations, [{ op: "remove", path: "/relations/2" }]);
  }
});

test("legacy hierarchy dependencies export both directions and participate in cycle checks", async (t) => {
  const { pm, identities, ids } = await relationTracker(t, 3);
  await pm.update(ids[0]!, { dep: [`id=${ids[1]},kind=child`] });
  await pm.update(ids[2]!, { dep: [`id=${ids[1]},kind=parent`] });
  const plan = await exportRelations({ id: 2, rev: 1, fields: {}, relations: [] }, CONFIG.orgUrl, identities, pm);
  assert.deepEqual(plan.operations.map((op) => (op.value as AdoRelation).rel).sort(), ["System.LinkTypes.Hierarchy-Forward", "System.LinkTypes.Hierarchy-Reverse"]);
  assert.deepEqual((await importRelations([], CONFIG.orgUrl, identities, pm)).updated, []);
  await assert.rejects(() => importRelations([{ id: 1, rev: 1, fields: {}, relations: [edge("System.LinkTypes.Hierarchy-Reverse", 3)] }], CONFIG.orgUrl, identities, pm), /cycle/u);
});

test("unmapped local kinds and targets are reported while mapped custom dependency directions round-trip", async (t) => {
  const { pm, identities, ids } = await relationTracker(t, 3);
  const custom = { "Custom.Before": "blocks" as const, "Custom.After": "blocked_by" as const, "Custom.Checks": "verifies" as const };
  await importRelations([{ id: 1, rev: 1, fields: {}, relations: [edge("Custom.Before", 2), edge("Custom.Checks", 2)] }], CONFIG.orgUrl, identities, pm, custom);
  let plan = await exportRelations({ id: 2, rev: 1, fields: {}, relations: [] }, CONFIG.orgUrl, identities, pm, custom);
  assert.deepEqual(plan.operations.map((op) => (op.value as AdoRelation).rel), ["Custom.After"]);
  await pm.update(ids[0]!, { dep: [`id=${ids[1]},kind=supersedes`, `id=${ids[2]},kind=related`] });
  plan = await exportRelations({ id: 1, rev: 1, fields: {}, relations: [] }, CONFIG.orgUrl, new Map([[1, ids[0]!], [2, ids[1]!]]), pm, custom);
  assert.deepEqual(plan.unmappedLocal.map((edge) => edge.kind).sort(), ["related", "supersedes"]);
});

test("all custom SDK hierarchy and association aliases normalize before storage", async (t) => {
  const { pm, identities, ids } = await relationTracker(t, 6);
  const custom = { "Custom.Epic": "epic" as const, "Custom.ChildOf": "child_of" as const, "Custom.Task": "task" as const, "Custom.ParentChild": "parent_child" as const, "Custom.Related": "related_to" as const };
  await importRelations([
    { id: 2, rev: 1, fields: {}, relations: [edge("Custom.Epic", 1), edge("Custom.ChildOf", 1), edge("Custom.Task", 3), edge("Custom.ParentChild", 4), edge("Custom.Related", 5)] },
  ], CONFIG.orgUrl, identities, pm, custom);
  const rows = (await pm.listAllComplete()).items;
  assert.equal(rows.find((row) => row.id === ids[1])!.parent, ids[0]);
  assert.equal(rows.find((row) => row.id === ids[2])!.parent, ids[1]);
  assert.equal(rows.find((row) => row.id === ids[3])!.parent, ids[1]);
  assert.equal(rows.find((row) => row.id === ids[1])!.dependencies![0]!.kind, "related");
});

test("legacy imported dependencies without provenance or resolved targets remain observable", async (t) => {
  const { pm, identities, pmRoot } = await relationTracker(t, 1);
  const { items } = await pm.listAllComplete();
  const id = "fixture-legacy";
  const result = await commitImportedItem({
    pmRoot, id, itemPath: join(pmRoot, "tasks", `${id}.toon`),
    document: {
      metadata: { ...items[0]!, id, dependencies: [
        { id: "fixture-absent-parent", kind: "parent", created_at: "2026-01-01T00:00:00.000Z" },
        { id: "fixture-absent-child", kind: "child", created_at: "2026-01-01T00:00:00.000Z" },
      ] },
      body: "",
    },
    author: "fixture-agent", message: "Legacy external fixture",
    settings: await readSettings(pmRoot), conflictWarningPrefix: "fixture_import_conflict",
  });
  assert.equal(result.committed, true);
  assert.deepEqual((await importRelations([], CONFIG.orgUrl, identities, pm)).updated, []);
  const rows = (await pm.listAllComplete()).items;
  assert.equal(rows.find((row) => row.id === id)!.dependencies!.length, 2);
});

test("batch hierarchy preflight refuses a disconnected cycle before even the first local mutation", async (t) => {
  const { pm, identities, ids, pmRoot } = await relationTracker(t, 4);
  const histories = ids.map((id) => readFileSync(join(pmRoot, "history", `${id}.jsonl`), "utf8"));
  await assert.rejects(() => importRelations([
    { id: 3, rev: 1, fields: {}, relations: [edge("System.LinkTypes.Hierarchy-Reverse", 4)] },
    { id: 4, rev: 1, fields: {}, relations: [edge("System.LinkTypes.Hierarchy-Reverse", 3)] },
  ], CONFIG.orgUrl, identities, pm), /cycle/u);
  assert.deepEqual(ids.map((id) => readFileSync(join(pmRoot, "history", `${id}.jsonl`), "utf8")), histories,
    "even the first otherwise valid parent assignment must not persist");
  assert.ok((await pm.listAllComplete()).items.every((item) => item.parent === undefined));
});

test("missing custom configuration reports provenance instead of adding a lossy built-in alias", async (t) => {
  const { pm, identities, ids } = await relationTracker(t, 2);
  const remote = { id: 1, rev: 1, fields: {}, relations: [edge("Custom.Association", 2)] };
  await importRelations([remote], CONFIG.orgUrl, identities, pm, { "Custom.Association": "related" });
  const plan = await exportRelations(remote, CONFIG.orgUrl, identities, pm);
  assert.deepEqual(plan.operations, []);
  assert.equal(plan.unmapped.length, 1);
  assert.deepEqual(plan.unmappedLocal, [{ id: ids[0], kind: "related", target: ids[1] }]);
  await pm.update(ids[0]!, { dep: [`id=${ids[1]},kind=blocks,source_kind=System.LinkTypes.Related`] });
  assert.equal((await exportRelations(remote, CONFIG.orgUrl, identities, pm)).unmappedLocal.length, 2);
});
