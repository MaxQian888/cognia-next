/**
 * Agent capability vocabulary (ADR-0090) shared by every execution rail.
 *
 * Moved here from `@cognia/agent-config-types/agent-execution` so external
 * integrations and engines can name capabilities without depending on the
 * app's configuration type hub; that module re-exports these names.
 */

/**
 * The runtime adapter actually frozen into a spec. Unlike the caller's runtime
 * policy this includes `external`, which is never chosen by policy directly — it is derived from an external-agent binding (teammate
 * runtime / preset) by the resolver.
 */
export type AgentRuntimeAdapterId = "claude-agent-sdk" | "ai-sdk" | "external"

/**
 * Capability vocabulary for the compatibility matrix and the per-spec
 * effective set. "Hard" vs "preferred" is a property of the *request*
 * (`AgentExecutionPolicy.requires` / `prefers`), not of the id itself.
 */
export type AgentCapabilityId =
  | "streaming"
  | "session.multi-turn"
  | "session.resume"
  | "tools.ordinary"
  | "tools.parallel"
  | "tools.fragmented-json"
  | "tools.results"
  | "tools.errors"
  | "mcp"
  | "permissions.interrupt-resume"
  | "permissions.set-mode"
  | "prompt-caching"
  | "thinking"
  | "context-management"
  | "images"
  | "beta-features"
  | "rate-limit-handling"
  | "upstream-errors"
  | "stream-interruption"
  | "subagents.native"
  | "steer"
  | "set-model"
  | "checkpoint"
  | "compaction"
  // --- Claude Agent SDK 0.3.220 parity (see protocol/agent-sdk-surface.json) ---
  // Each of these names a surface the SDK exposes and the unified contract has
  // to be able to answer "yes / equivalent / no" about, per runtime. They are
  // deliberately runtime-neutral: an AI SDK adapter can satisfy
  // `output.structured` through its own JSON-schema path without the contract
  // caring how.
  | "output.structured"
  | "session.store"
  | "session.manage"
  | "permissions.update-rules"
  | "hooks.lifecycle"
  | "input.elicitation"
  | "input.dialog"
  | "plugins.native"
  | "skills.native"
  | "mcp.dynamic"
  | "subagents.manage"
  | "tasks.background"
  | "commands.dynamic"
  | "sandbox.native"
  | "observability.child"
  | "startup.prewarm"

export const AGENT_CAPABILITY_IDS: readonly AgentCapabilityId[] = [
  "streaming",
  "session.multi-turn",
  "session.resume",
  "tools.ordinary",
  "tools.parallel",
  "tools.fragmented-json",
  "tools.results",
  "tools.errors",
  "mcp",
  "permissions.interrupt-resume",
  "permissions.set-mode",
  "prompt-caching",
  "thinking",
  "context-management",
  "images",
  "beta-features",
  "rate-limit-handling",
  "upstream-errors",
  "stream-interruption",
  "subagents.native",
  "steer",
  "set-model",
  "checkpoint",
  "compaction",
  "output.structured",
  "session.store",
  "session.manage",
  "permissions.update-rules",
  "hooks.lifecycle",
  "input.elicitation",
  "input.dialog",
  "plugins.native",
  "skills.native",
  "mcp.dynamic",
  "subagents.manage",
  "tasks.background",
  "commands.dynamic",
  "sandbox.native",
  "observability.child",
  "startup.prewarm",
]

/** Narrow helper used by tests + adapters when only capability ids are known at runtime. */
export function isAgentCapabilityId(v: unknown): v is AgentCapabilityId {
  return typeof v === "string" && (AGENT_CAPABILITY_IDS as readonly string[]).includes(v)
}

/**
 * How well a runtime satisfies a capability.
 *
 * The distinction that matters is `equivalent`: an adapter that reaches the
 * same observable outcome by another mechanism (an AI SDK provider doing
 * structured output through its own schema path rather than the SDK's
 * `outputFormat`). Recording it as `native` would erase a real behavioural
 * difference; recording it as `unsupported` would fail a session that works.
 */
export type AgentCapabilitySupport = "native" | "equivalent" | "unsupported"

/**
 * Per-capability verdict. `reason` is required for anything other than
 * `native` — an `unsupported` with no explanation is indistinguishable from an
 * unfinished adapter, and that ambiguity is what fail-closed exists to prevent.
 */
export interface AgentCapabilityEvidence {
  support: AgentCapabilitySupport
  reason?: string
}
