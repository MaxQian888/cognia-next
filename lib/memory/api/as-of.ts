/**
 * Shared `asOf` argument parser for the external memory search surfaces
 * (MCP `memory_search`, companion RPC `memory_search`) — ADR-0202 §2. Callers
 * pass epoch milliseconds or an ISO 8601 string; `searchMemoriesExternal`
 * takes the resolved epoch-ms instant.
 */

/** Parse an `asOf` argument; throws on anything that is not a real instant. */
export function parseMemoryAsOf(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined
  const instant = typeof value === "number" ? value : Date.parse(value)
  if (!Number.isFinite(instant) || instant <= 0) {
    throw new Error("asOf must be epoch milliseconds or an ISO 8601 timestamp")
  }
  return instant
}
