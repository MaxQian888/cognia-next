/** Wait for the existing trace transport, including already-started writes. */
export async function waitForEvalTracePersistence(): Promise<void> {
  const { getTransport } = await import("@cognia/logging/core")
  const transport = getTransport("agent-trace")
  if (!transport) return
  await transport.flush?.()
  const health = transport.getHealth?.()
  if (health?.status === "degraded") {
    throw new Error(`Evaluation trace persistence failed: ${health.lastError ?? "write failed"}`)
  }
}
