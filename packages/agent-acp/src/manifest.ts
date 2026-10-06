/**
 * ACP integration manifest (ADR-0217).
 *
 * ACP is a protocol, not one vendor: every ACP agent in the runtime catalog
 * (Claude Code, Codex, Gemini, Goose, Kimi, Qoder, Cline, Devin, …) is a row
 * the ACP adapter runs, so the package contributes no ecosystem row. Pure
 * data: importing it never loads the client.
 */

import type { AgentProtocolIntegration } from "@cognia/agent-contracts/ecosystem"
import type { AgentExecutionSemantics } from "@cognia/agent-contracts/semantics"

export const ACP_PROTOCOL = "acp"

/**
 * A stdio ACP agent: one process serves every session of a configuration. A
 * cancel is the `session/cancel` notification, which ends the prompt turn and
 * leaves the session open. `session/resume` (or legacy `session/load`)
 * reattaches to the agent's stored session and `session/fork` branches it,
 * both gated on the agent's advertised capabilities. The agent asks for each
 * tool call through `session/request_permission`.
 */
export const ACP_EXECUTION_SEMANTICS: AgentExecutionSemantics = Object.freeze({
  cancel: Object.freeze({ scope: "turn", reconnectsAfterCancel: false }),
  resume: "native",
  fork: "native",
  approvals: "per-tool-call",
  processModel: "shared",
}) as AgentExecutionSemantics

/** The same protocol reached over HTTP, SSE or WebSocket: the host owns no process. */
export const ACP_REMOTE_EXECUTION_SEMANTICS: AgentExecutionSemantics = Object.freeze({
  ...ACP_EXECUTION_SEMANTICS,
  processModel: "remote",
}) as AgentExecutionSemantics

/**
 * Devin over stdio: native MCP configuration is read once per process, so each
 * conversation owns its own ACP process (`DevinAcpAdapter`).
 */
export const DEVIN_ACP_EXECUTION_SEMANTICS: AgentExecutionSemantics = Object.freeze({
  ...ACP_EXECUTION_SEMANTICS,
  processModel: "per-session",
}) as AgentExecutionSemantics

/** The Devin preset id; a hand-pointed `devin` binary runs the same adapter. */
export const DEVIN_PRESET_ID = "devin"

export const acpProtocolIntegration: AgentProtocolIntegration = Object.freeze({
  protocol: ACP_PROTOCOL,
  semantics: ACP_EXECUTION_SEMANTICS,
  presetSemantics: Object.freeze({ [DEVIN_PRESET_ID]: DEVIN_ACP_EXECUTION_SEMANTICS }),
}) as AgentProtocolIntegration
