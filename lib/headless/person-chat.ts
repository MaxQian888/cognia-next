import type { PersonPartitionCapabilities } from "@cognia/agent-config-types/host-state"

let capability: PersonPartitionCapabilities = { chat: "none" }

/** Capture Host opt-in once at boot; older Hosts leave execution dormant. */
export function initializePersonChat(
  host: string,
  env: Readonly<Record<string, string | undefined>>
): void {
  capability = Object.freeze({
    chat: host === "person-brain" && env.COGNIA_PERSON_CHAT === "tool-less" ? "tool-less" : "none",
  })
}

export function personChatCapability(): PersonPartitionCapabilities {
  return capability
}
