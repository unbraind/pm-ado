/** Actual loopback HTTP binding shared by fixture servers. */
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Bind an existing fixture server and certify its TCP address without changing its ownership. */
export async function listenOnLoopback(server: Server): Promise<AddressInfo> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address;
}
