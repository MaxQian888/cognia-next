/**
 * Turning a real handshake into merge layer 4 (ADR-0090 external SSOT).
 *
 * The negotiated `AcpCapabilities` (and the agent's advertised command list)
 * are the only evidence that describes THIS agent build rather than its
 * protocol. Everything here is therefore stamped `handshake`, and every value
 * is derived from something the agent actually said — an absent field produces
 * NO cell, never a cell claiming "not negotiated means no", because the merge
 * would then let a silent handshake overrule a correct manifest row.
 *
 * Pure: no adapter calls, no IO. The manager collects the inputs; this decides
 * what they mean.
 */

import type { AcpAvailableCommand, AcpCapabilities } from "@/types/agent/external-agent"
import type {
  ExternalAgentCapabilityMatrix,
  ExternalAgentCapabilityCell,
} from "@cognia/agent-config-types/external-agent-capability"

import { resolveCommandCompactionCapability } from "./session-capabilities"

const yes = (reasonKey: string): ExternalAgentCapabilityCell => ({
  level: "native",
  evidence: "handshake",
  reasonKey,
})

const no = (reasonKey: string): ExternalAgentCapabilityCell => ({
  level: "unsupported",
  evidence: "handshake",
  reasonKey,
})

export interface LiveCapabilityFactsInput {
  /** What the agent advertised during `initialize`. Absent ⇒ no cells at all. */
  negotiated?: AcpCapabilities
  /** The session's advertised slash commands, when the agent published any. */
  availableCommands?: readonly AcpAvailableCommand[]
}

/**
 * Layer-4 cells for one agent.
 *
 * Note the asymmetry on `mcpTools`: an explicit `false` is a refusal and is
 * recorded, while an omission is not. ACP agents that accept `session/new` MCP
 * servers advertise the flag, but not advertising it has always meant "the
 * protocol slot exists" in this codebase (`canHostCogniaTools`), and turning
 * that omission into an `unsupported` would break every shipped preset.
 */
export function liveCapabilityFacts(
  input: LiveCapabilityFactsInput
): ExternalAgentCapabilityMatrix {
  const cells: ExternalAgentCapabilityMatrix = {}
  const negotiated = input.negotiated

  if (negotiated) {
    if (negotiated.streaming === true) cells.streaming = yes("negotiatedStreaming")
    if (negotiated.streaming === false) cells.streaming = no("negotiatedNoStreaming")

    // `multiTurn` is not what its name suggests. `acp-client.ts` sets it from
    // `initResult.agentCapabilities.loadSession`, so it answers "can this agent
    // REOPEN a session?" — the resume capability, not the multi-turn one.
    // Mapping it to `session.multi-turn` would both understate resume and
    // overwrite a correct manifest row for a protocol that is multi-turn by
    // construction.
    if (negotiated.multiTurn === true) cells["session.resume"] = yes("negotiatedLoadSession")
    if (negotiated.multiTurn === false) cells["session.resume"] = no("negotiatedNoLoadSession")

    if (negotiated.mcpTools === false) cells.mcp = no("negotiatedNoMcpTools")

    if (negotiated.thinking === true) cells.thinking = yes("negotiatedThinking")
    if (negotiated.thinking === false) cells.thinking = no("negotiatedNoThinking")

    if (negotiated.toolExecution === false) {
      // An agent that cannot execute tools cannot produce tool results or tool
      // errors either; recording only `tools.ordinary` would leave two cells
      // claiming an outcome that can never occur.
      cells["tools.ordinary"] = no("negotiatedNoToolExecution")
      cells["tools.results"] = no("negotiatedNoToolExecution")
      cells["tools.errors"] = no("negotiatedNoToolExecution")
    }
  }

  // Compaction is the one capability whose answer is genuinely per-session:
  // ACP has no compaction method, so the only route is a `/compact` or
  // `/compress` the agent chose to advertise. The manifest row says `unknown`
  // for exactly this reason.
  if (input.availableCommands) {
    const compaction = resolveCommandCompactionCapability(input.availableCommands)
    cells.compaction =
      compaction.status === "supported"
        ? { level: "equivalent", evidence: "handshake", reasonKey: "advertisedCompactCommand" }
        : no("noAdvertisedCompactCommand")
  }

  return cells
}
