/**
 * One description of an agent that ships with the app.
 *
 * "Built-in" means exactly this: a definition Cognia ships, which a user or
 * project may replace. It is not the name of a hosting mechanism (see ADR-0161
 * and `lib/ai/agent/runtime-catalog` for the runtime axis).
 *
 * Before this catalog the app and the CLI each hand-wrote their own list. The
 * app shipped four `workflow-*` agents plus `Explore` and `Plan`, the CLI
 * shipped `general-purpose`, `Explore` and `Plan`, and the two `Explore` and
 * `Plan` definitions had different prompts and different descriptions. They
 * were two different agents wearing one name.
 */

/** Where a built-in is offered. An entry can appear on more than one. */
export type BuiltinAgentSurface =
  /** Injected into `SendOptions.agents` for a workflow-editor session. */
  | "workflow-editor"
  /** Injected into `SendOptions.agents` for a team session. */
  | "team"
  /** Targetable by the `dispatch_agent` host tool, in any chat context. */
  | "dispatch"
  /** Offered by the CLI's own subagent discovery. */
  | "cli"

/**
 * What the agent may reach.
 *
 * `inherit` takes the dispatcher's full toolset. `read-only` takes the derived
 * read-only surface, which is every built-in tool the shared risk model marks
 * `requiresApproval: false`. Both shells resolve `read-only` from that same
 * source (`lib/settings/builtin-tools`), so the two cannot drift: a newly added
 * read-only tool joins automatically, and a tool reclassified as risky leaves.
 * `allowlist` names an explicit set, which is how the workflow agents are
 * clamped to the `wf_*` tools without also reaching the run tools.
 */
export type BuiltinToolPolicy =
  { kind: "inherit" } | { kind: "read-only" } | { kind: "allowlist"; tools: readonly string[] }

export interface BuiltinAgentEntry {
  /** Dispatcher id. Bare, so a user or project definition can shadow it. */
  id: string
  /** Display label for pickers. */
  name: string
  /** What the dispatching model reads when it decides whether to use this. */
  description: string
  /** The system prompt the agent runs under. */
  prompt: string
  surfaces: readonly BuiltinAgentSurface[]
  toolPolicy: BuiltinToolPolicy
  /** Round-trip ceiling. Omitted means the runtime's own default. */
  maxTurns?: number
}
