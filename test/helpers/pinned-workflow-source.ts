import { setTimeout as delay } from "node:timers/promises";

/** Read one immutable workflow URL, retrying only interrupted transfers and transient HTTP failures. */
export async function fetchPinnedWorkflowSource(
  url: string,
  fetchSource: typeof fetch = fetch,
  wait: (milliseconds: number) => Promise<unknown> = delay,
): Promise<string> {
  const maxAttempts = 4;
  for (let attempt = 1; ; attempt++) {
    let failure: unknown;
    try {
      const response = await fetchSource(url, { signal: AbortSignal.timeout(30_000), redirect: "manual" });
      if (response.ok) return await response.text();
      await response.body?.cancel().catch(() => undefined);
      const { status } = response;
      failure = new Error(`Cannot read pinned Daily Release source (HTTP ${status})`);
      if (status !== 408 && status !== 429 && (status < 500 || status > 599)) throw failure;
    } catch (error) {
      // Fetch reports connection and interrupted-body errors as TypeError.
      // The deadline can surface as TimeoutError from fetch or AbortError from the body.
      const timeout = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
      if (!(error instanceof TypeError || timeout)) throw error;
      failure = error;
    }
    if (attempt === maxAttempts) throw failure;
    await wait(250 * attempt);
  }
}
