/** Diagnostic fixtures must not mistake incomplete output or peer failures for isolation. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { probeWorkspaceLock } from "./helpers/workspace-lock-probe.ts";
import { peerOutcome } from "./helpers/peer-outcome.ts";

test("workspace peer diagnostics collect split output and certify only typed lock refusal", async () => {
  const peer = (script: string) => spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  assert.equal(await peerOutcome(peer('process.stdout.write("peer-"); setTimeout(() => process.stdout.write("committed\\n"), 10)')), "committed");
  assert.equal(await peerOutcome(peer('process.stdout.write("peer-blocked\\n"); process.exitCode = 4')), "blocked");
  for (const script of ['process.exitCode = 1', 'process.exitCode = 4', 'process.stdout.write("peer-committed"); process.exitCode = 4', 'process.stdout.write("unknown")']) {
    await assert.rejects(peerOutcome(peer(script)), /Uncertified peer outcome/u);
  }
});


test("workspace isolation probe completes every field when the native peer is blocked", async () => {
  let attempts = 0;
  assert.equal(await probeWorkspaceLock(async () => { attempts++; return "blocked"; }), 0);
  assert.equal(attempts, 4);
});
