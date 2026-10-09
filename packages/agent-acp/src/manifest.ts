/**
 * ACP integration manifest (ADR-0217).
 *
 * ACP is a protocol, not one vendor: every ACP agent in the runtime catalog
 * (Claude Code, Codex, Gemini, Goose, Kimi, Qoder, Cline, Devin, …) is a row
 * the ACP adapter runs, so the package contributes no ecosystem row. Pure
 * data: importing it never loads the client.
 */

import type {
  AgentCapabilityContribution,
  AgentProtocolIntegration,
} from "@cognia/agent-contracts/ecosystem"
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

/**
 * ACP's capability rows. `pnpm gen:agent-capabilities` writes them into
 * `protocol/agent-capabilities.json`; edit them here, never there.
 */
export const ACP_CAPABILITIES: AgentCapabilityContribution = {
  protocols: {
    acp: {
      label: "Agent Client Protocol (ACP v1)",
      note: "Rows follow the ACP v1 schema Cognia negotiates in `acp-client.ts`.",
      capabilities: {
        streaming: {
          level: "native",
          evidence: "protocol-spec",
        },
        "session.multi-turn": {
          level: "native",
          evidence: "protocol-spec",
        },
        "session.resume": {
          level: "unknown",
          evidence: "none",
          reasonKey: "notNegotiated",
        },
        "tools.ordinary": {
          level: "native",
          evidence: "protocol-spec",
        },
        "tools.parallel": {
          level: "unknown",
          evidence: "none",
        },
        "tools.fragmented-json": {
          level: "unknown",
          evidence: "none",
        },
        "tools.results": {
          level: "native",
          evidence: "protocol-spec",
        },
        "tools.errors": {
          level: "native",
          evidence: "protocol-spec",
        },
        mcp: {
          level: "native",
          evidence: "protocol-spec",
        },
        "permissions.interrupt-resume": {
          level: "native",
          evidence: "protocol-spec",
        },
        "permissions.set-mode": {
          level: "native",
          evidence: "adapter-code",
        },
        "prompt-caching": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "agentOwned",
        },
        thinking: {
          level: "unknown",
          evidence: "none",
        },
        "context-management": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "agentOwned",
        },
        // Per agent build: `promptCapabilities.image` defaults to false, so the
        // handshake answers it (`capability-live-facts.ts`), not the protocol.
        images: {
          level: "unknown",
          evidence: "protocol-spec",
          reasonKey: "notNegotiated",
        },
        "beta-features": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "rate-limit-handling": {
          level: "unknown",
          evidence: "none",
        },
        "upstream-errors": {
          level: "native",
          evidence: "protocol-spec",
        },
        "stream-interruption": {
          level: "native",
          evidence: "protocol-spec",
        },
        "subagents.native": {
          level: "unknown",
          evidence: "none",
        },
        steer: {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "set-model": {
          level: "native",
          evidence: "adapter-code",
        },
        checkpoint: {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        compaction: {
          level: "unknown",
          evidence: "none",
        },
        "output.structured": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "session.store": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "sidecarOnly",
        },
        "session.manage": {
          level: "native",
          evidence: "adapter-code",
        },
        "permissions.update-rules": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "hooks.lifecycle": {
          level: "unknown",
          evidence: "none",
        },
        "input.elicitation": {
          level: "native",
          evidence: "protocol-spec",
        },
        "input.dialog": {
          level: "unknown",
          evidence: "none",
        },
        "plugins.native": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "agentOwned",
        },
        "skills.native": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "agentOwned",
        },
        "mcp.dynamic": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "subagents.manage": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "tasks.background": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "commands.dynamic": {
          level: "native",
          evidence: "protocol-spec",
        },
        "sandbox.native": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "observability.child": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "sidecarOnly",
        },
        "startup.prewarm": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "sidecarOnly",
        },
        "mcp.logs": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "agentOwned",
        },
        "rate-limit-reporting": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "sidecarOnly",
        },
        "subagents.model-selection": {
          level: "unknown",
          evidence: "none",
        },
        "models.list": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "web.search": {
          level: "unknown",
          evidence: "none",
        },
      },
    },
  },
  presetRefinements: {
    devin: {
      protocol: "acp",
      note: "`devin acp` publishes only `mode` and `model` session config options; reasoning intensity is encoded in the model ids themselves (`…-low`, `…-high`, `…-xhigh`, `…-max`). DevinAcpAdapter synthesizes a `thought_level` select over the current model family and writes a level back as a model-variant switch, so the axis is `equivalent`, not `native`.",
      capabilities: {
        thinking: {
          level: "equivalent",
          evidence: "adapter-code",
          reasonKey: "modelVariantOverlay",
        },
      },
    },
  },
}
