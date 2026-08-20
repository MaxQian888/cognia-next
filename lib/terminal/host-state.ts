export type TerminalHostState =
  | "online"
  | "offline"
  | "unpaired"
  | "unauthorized"
  | "reconnecting"
  | "resource_limited"
  | "incompatible"
  /**
   * The host has remote terminal access switched off entirely — a different
   * thing from this device being unauthorized, and it needs a different
   * remedy: the switch, not a grant.
   *
   * It has to be classified from the ticket response, because the WebSocket
   * upgrade's 403 is invisible to a browser: `WebSocket` reports a rejected
   * handshake as an untyped `error` event with no status, which lands here as
   * plain "offline" and sends the user looking for a network fault.
   */
  | "remote_access_disabled"

export function classifyTerminalHostError(error: unknown): Exclude<TerminalHostState, "online"> {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (message.includes("unpaired")) return "unpaired"
  // Checked before the generic permission match below: the ticket refusal is
  // also a 403, and reporting it as "not allowed to use remote terminals"
  // would point an owner device at a grant it already holds.
  if (message.includes("terminal_remote_access_disabled")) return "remote_access_disabled"
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
