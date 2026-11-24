import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchPinnedWorkflowSource } from "./helpers/pinned-workflow-source.ts";

const pinnedUrl = "https://example.invalid/pm-ops/0123456789abcdef0123456789abcdef01234567/daily-release.yml";

/** Record every request, timeout signal, and backoff without making a network call. */
function fixture(...results: (Response | Error)[]) {
  const requests: { url: string; options: RequestInit | undefined }[] = [];
  const waits: number[] = [];
  const source = fetchPinnedWorkflowSource(pinnedUrl, async (input, options) => {
    requests.push({ url: String(input), options });
    const result = results.shift();
    assert.ok(result, "unexpected extra fetch attempt");
    if (result instanceof Error) throw result;
    return result;
  }, async milliseconds => { waits.push(milliseconds); });
  return { source, requests, waits };
}

test("two transient source failures recover at the identical pinned URL", async () => {
  const interruptedBody = new ReadableStream({
    start(controller) { controller.error(new DOMException("body deadline", "AbortError")); },
  });
  for (const timeout of [new DOMException("attempt timed out", "TimeoutError"), new Response(interruptedBody)]) {
    const { source, requests, waits } = fixture(
      new Response("temporary outage", { status: 503 }),
      timeout,
      new Response("canonical source"),
    );
    assert.equal(await source, "canonical source");
    assert.deepEqual(requests.map(request => request.url), [pinnedUrl, pinnedUrl, pinnedUrl]);
    assert.ok(requests.every(({ options }) => options?.redirect === "manual" && options.signal instanceof AbortSignal));
    assert.equal(new Set(requests.map(({ options }) => options?.signal)).size, 3);
    assert.deepEqual(waits, [250, 500]);
  }
});

test("a missing source or a redirect fails on the first attempt", async () => {
  for (const status of [404, 302]) {
    const { source, requests, waits } = fixture(new Response(null, { status }));
    await assert.rejects(source, new RegExp(`HTTP ${status}`, "u"));
    assert.deepEqual(requests.map(request => request.url), [pinnedUrl]);
    assert.deepEqual(waits, []);
  }
});

test("four transient failures exhaust the retry budget at the identical pinned URL", async () => {
  const final = new TypeError("connection lost");
  const { source, requests, waits } = fixture(
    new Response(null, { status: 408 }),
    new Response(null, { status: 429 }),
    new Response(null, { status: 502 }),
    final,
  );
  await assert.rejects(source, error => error === final);
  assert.deepEqual(requests.map(request => request.url), Array(4).fill(pinnedUrl));
  assert.deepEqual(waits, [250, 500, 750]);
});

test("a nontransport exception propagates immediately", async () => {
  const broken = new Error("invalid source contract");
  const { source, requests, waits } = fixture(broken);
  await assert.rejects(source, error => error === broken);
  assert.equal(requests.length, 1);
  assert.deepEqual(waits, []);
});
