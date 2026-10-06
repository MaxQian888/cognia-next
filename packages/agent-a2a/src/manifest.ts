/**
 * A2A integration manifest (ADR-0217).
 *
 * A2A is a protocol, not one vendor: any agent that publishes an Agent Card
 * and a JSON-RPC interface is reached through it, so the package contributes
 * no ecosystem row. Pure data: importing it never loads the adapter.
 */

import type { AgentExecutionSemantics } from "@cognia/agent-contracts/semantics"

/**
 * A remote agent the host owns no process for. A cancel is `tasks/cancel` for
 * the running task; the conversation context survives it. The adapter keeps
 * no session store to resume or fork from, and A2A has no tool-approval
 * channel.
 */
export const A2A_EXECUTION_SEMANTICS: AgentExecutionSemantics = Object.freeze({
  cancel: Object.freeze({ scope: "turn", reconnectsAfterCancel: false }),
  resume: "unsupported",
  fork: "unsupported",
  approvals: "none",
  processModel: "remote",
}) as AgentExecutionSemantics

export const A2A_PROTOCOL = "a2a"
