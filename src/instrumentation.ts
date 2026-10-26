/**
 * Next.js start-up hook. The work is Node-only (database, crypto), so it lives in
 * instrumentation-node.ts and is loaded only on the Node.js runtime.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startNode } = await import("./instrumentation-node");
    await startNode();
  }
}
