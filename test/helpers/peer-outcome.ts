/** Collect a diagnostic peer's complete output and distinguish certified lock refusal from failure. */
import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

/** The peer exits with a dedicated code only after a typed native lock conflict. */
export async function peerOutcome(child: ChildProcess & { stdout: Readable; stderr: Readable }): Promise<"committed" | "blocked"> {
  let stdout = "", killed = false;
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.resume();
  const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, 15_000);
  try {
    // close follows stream drainage; exit may precede the final stdout chunks.
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    if (killed) throw new Error("Peer write exceeded the bounded wait; inspect SDK lock behaviour before changing sync.");
    if (code === 0 && stdout.trim() === "peer-committed") return "committed";
    if (code === 4 && stdout.trim() === "peer-blocked") return "blocked";
    throw new Error(`Uncertified peer outcome (exit ${code}); inspect SDK isolation before changing sync.`);
  } finally { clearTimeout(timer); }
}
