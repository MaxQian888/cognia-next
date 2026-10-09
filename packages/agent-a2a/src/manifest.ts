/**
 * A2A integration manifest (ADR-0217).
 *
 * A2A is a protocol, not one vendor: any agent that publishes an Agent Card
 * and a JSON-RPC interface is reached through it, so the package contributes
 * no ecosystem row. Pure data: importing it never loads the adapter.
 */

import type { AgentCapabilityContribution } from "@cognia/agent-contracts/ecosystem"
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

/**
 * A2A's capability rows. `pnpm gen:agent-capabilities` writes them into
 * `protocol/agent-capabilities.json`; edit them here, never there.
 */
export const A2A_CAPABILITIES: AgentCapabilityContribution = {
  protocols: {
    a2a: {
      label: "Agent-to-Agent Protocol (Google A2A)",
      note: "A2A is a task transport: almost everything depends on the remote Agent Card, which is a LIVE fact, so the static row asserts only what the spec fixes.",
      capabilities: {
        streaming: {
          level: "unknown",
          evidence: "none",
          reasonKey: "notNegotiated",
        },
        "session.multi-turn": {
          level: "native",
          evidence: "protocol-spec",
        },
        "session.resume": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "tools.ordinary": {
          level: "unknown",
          evidence: "none",
          reasonKey: "notNegotiated",
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
          level: "unknown",
          evidence: "none",
          reasonKey: "notNegotiated",
        },
        mcp: {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "permissions.interrupt-resume": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "permissions.set-mode": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "prompt-caching": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "agentOwned",
        },
        thinking: {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "context-management": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "agentOwned",
        },
        // Image parts ride as file parts (raw bytes or a URL), both A2A versions.
        images: {
          level: "native",
          evidence: "adapter-code",
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
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        checkpoint: {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        compaction: {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
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
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
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
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
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
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
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
}
