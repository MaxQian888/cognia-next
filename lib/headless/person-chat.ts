import type { PersonPartitionCapabilities } from "@cognia/agent-config-types/host-state"

let capability: PersonPartitionCapabilities = { chat: "none", execution: "none" }

/**
 * Capture Host opt-in once at boot; older Hosts leave execution dormant.
 *
 * Both flags come from the Host's person-brain supervisor only (it strips them
 * from the operator environment). `COGNIA_PERSON_EXECUTION=sandboxed` is
 * advertised only while the Host's sandbox pool conforms (P6d), and is what
 * lets this partition run the member's agent (P6e).
 */
export function initializePersonChat(
  host: string,
  env: Readonly<Record<string, string | undefined>>
): void {
  const person = host === "person-brain"
  capability = Object.freeze({
    chat: person && env.COGNIA_PERSON_CHAT === "tool-less" ? "tool-less" : "none",
    execution: person && env.COGNIA_PERSON_EXECUTION === "sandboxed" ? "sandboxed" : "none",
  })
}

export function personChatCapability(): PersonPartitionCapabilities {
  return capability
}
