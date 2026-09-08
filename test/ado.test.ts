/**
 * Behavioural tests for pm-ado.
 *
 * The extension is driven through pm's real registration and activation engine
 * via `createExtensionTestHarness`, not a hand-rolled `api` double: a double
 * would assert the extension against itself and stay green through a host
 * rejection such as a flag collision that aborts command registration.
 */
import assert from "node:assert/strict";
import test from "node:test";

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
  const { links, unmapped } = mapRelations(item);
  assert.deepEqual(links, [
    { kind: "parent", targetId: 12 },
    { kind: "related", targetId: 34 },
  ]);
  // Both the unknown relation kind and the non-item URL are surfaced, so an
  // import cannot look complete while silently discarding edges.
  assert.deepEqual(unmapped, ["AttachedFile", "System.LinkTypes.Related"]);

  assert.deepEqual(mapRelations({ id: 2, rev: 1, fields: {} }), { links: [], unmapped: [] });
  // Hierarchy-Reverse is the PARENT end; getting this backwards inverts a tree.
  assert.equal(RELATION_MAP["System.LinkTypes.Hierarchy-Reverse"], "parent");
  assert.equal(STATE_MAP.in_progress, "Active");
});

test("relationTargetId accepts only a positive integer final segment", () => {
  // A URL with no separator is its own final segment - both branches of the
  // lookup are reachable, which is why this does not need a guard for a case
  // that cannot happen.
  assert.equal(relationTargetId("42"), 42);
  // Extracting the segment before testing it keeps the pattern anchored. An
  // unanchored search for the segment was quadratic on a run of separators.
  assert.equal(relationTargetId("/".repeat(64) + "7"), 7);
  assert.equal(relationTargetId("/".repeat(64)), undefined);
  assert.equal(relationTargetId("https://x/_apis/wit/workItems/7"), 7);
  assert.equal(relationTargetId("https://x/_apis/wit/workItems/0"), undefined);
  assert.equal(relationTargetId("https://x/_apis/wit/workItems/-3"), undefined);
  assert.equal(relationTargetId(""), undefined);
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
