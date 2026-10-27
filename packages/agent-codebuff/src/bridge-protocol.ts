/** JSONL is private to Cognia's process bridge, not a claimed upstream CLI protocol. */
export const CODEBUFF_BRIDGE_FRAME_LIMIT = 1024 * 1024
const TYPES = new Set([
  "init",
  "ready",
  "run",
  "cancel",
  "host-request",
  "host-result",
  "event",
  "chunk",
  "result",
  "error",
  "network-head",
  "network-chunk",
  "network-end",
  "network-error",
  "network-ack",
  "network-cancel",
])
export interface BridgeFrame {
  type: string
  [key: string]: unknown
}
export function parseBridgeFrame(line: string): BridgeFrame {
  if (line.length > CODEBUFF_BRIDGE_FRAME_LIMIT)
    throw new Error("Codebuff bridge frame exceeded the 1 MiB limit")
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error("Malformed Codebuff bridge JSON")
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !TYPES.has(String((value as BridgeFrame).type))
  )
    throw new Error("Unsupported Codebuff bridge frame")
  return value as BridgeFrame
}
export function encodeBridgeFrame(value: BridgeFrame): string {
  const line = JSON.stringify(value)
  parseBridgeFrame(line)
  return line
}

/** Published SDK dispatches MCP before overrides; templates must stay MCP-free. */
export function assertCodebuffNoNativeMcp(value: unknown): void {
  const pending: unknown[] = [value]
  let inspected = 0
  while (pending.length) {
    const item = pending.pop()
    if (!item || typeof item !== "object") continue
    if (++inspected > 20_000) throw new Error("Codebuff state exceeded the inspection limit")
    for (const [key, child] of Object.entries(item)) {
      if (
        ["mcpServers", "mcpConfig", "mcpConfigs"].includes(key) &&
        child &&
        typeof child === "object" &&
        Object.keys(child).length
      )
        throw new Error("Codebuff SDK native MCP cannot be enforced by this host")
      if (child && typeof child === "object") pending.push(child)
    }
  }
}
