export type TerminalHostState =
  | "online"
  | "offline"
  | "unpaired"
  | "unauthorized"
  | "reconnecting"
  | "resource_limited"
  | "incompatible"

export function classifyTerminalHostError(error: unknown): Exclude<TerminalHostState, "online"> {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (message.includes("unpaired")) return "unpaired"
  if (message.includes("unauthorized") || message.includes("permission_denied")) {
    return "unauthorized"
  }
  if (message.includes("resource_limit") || message.includes("queue_overflow")) {
    return "resource_limited"
  }
  if (
    message.includes("incompatible") ||
    message.includes("magic") ||
    message.includes("protocol")
  ) {
    return "incompatible"
  }
  if (message.includes("reconnect")) return "reconnecting"
  return "offline"
}
