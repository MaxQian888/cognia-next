import type { ExternalAgentConfig } from "@/types/agent/external-agent"
import { cogniaGatewaySupport } from "./gateway-task"
import { piSubagentSupport } from "./pi-subagents"

/**
 * The model slots a gateway runtime can run on a model other than the task's
 * primary one. Declared here, beside the gateway projector that writes them
 * (`gateway-task.ts`), so the editors, the plan compiler (`model-plan.ts`) and
 * the projector read one list. A slot not listed for a runtime is refused at
 * admission; it is never guessed from a model name.
 *
 * `evidence` names the pinned upstream release whose configuration surface the
 * projection follows (checked 2026-10-20). It records where the contract came
 * from; it is not a claim that a live run on that release was verified.
 */
export interface AgentModelSlotDescriptor {
  id: "subagent.default" | "tier.haiku" | "tier.sonnet" | "tier.opus" | "aux.small"
  /**
   * `child-default`: the model a native child (subagent) uses when its own
   * definition and the spawning call name none. `tier`: what a model alias
   * resolves to. `auxiliary`: a helper call (titles, summaries) that is not a
   * child task.
   */
  kind: "child-default" | "tier" | "auxiliary"
  /** Reasoning efforts this slot accepts; absent means effort is not projected. */
  reasoningEfforts?: readonly string[]
  supportsSpawnModelOverrides?: boolean
  evidence: string
}

type SlotRuntimeConfig = Pick<
  ExternalAgentConfig,
  "protocol" | "transport" | "process" | "metadata" | "network"
>

const CLAUDE_EVIDENCE = "claude-code v2.1.304 (sub-agents, model-config)"
const CODEX_EVIDENCE =
  "codex >= 0.145 ([agents] keys); task-owned model_catalog_json (rust-v0.163.0)"
const OPENCODE_EVIDENCE = "opencode v1.19.3 (tool/task.ts, v1 + v2 config schema)"

/** The efforts Codex's `ReasoningEffort` accepts for a spawned child. */
const CODEX_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const

const CLAUDE_SLOTS: readonly AgentModelSlotDescriptor[] = [
  { id: "subagent.default", kind: "child-default", evidence: CLAUDE_EVIDENCE },
  { id: "tier.haiku", kind: "tier", evidence: CLAUDE_EVIDENCE },
  { id: "tier.sonnet", kind: "tier", evidence: CLAUDE_EVIDENCE },
  { id: "tier.opus", kind: "tier", evidence: CLAUDE_EVIDENCE },
]

const CODEX_SLOTS: readonly AgentModelSlotDescriptor[] = [
  {
    id: "subagent.default",
    kind: "child-default",
    reasoningEfforts: CODEX_REASONING_EFFORTS,
    supportsSpawnModelOverrides: true,
    evidence: CODEX_EVIDENCE,
  },
]

const OPENCODE_V1_SLOTS: readonly AgentModelSlotDescriptor[] = [
  { id: "subagent.default", kind: "child-default", evidence: OPENCODE_EVIDENCE },
  { id: "aux.small", kind: "auxiliary", evidence: OPENCODE_EVIDENCE },
]

/** OpenCode's V2 root schema has no `small_model`. */
const OPENCODE_V2_SLOTS: readonly AgentModelSlotDescriptor[] = [
  { id: "subagent.default", kind: "child-default", evidence: OPENCODE_EVIDENCE },
]

/**
 * The slots a configuration's gateway tasks can override. Empty when the
 * configuration cannot run on a Cognia model at all, or when its runtime has
 * no slot projection yet (it then keeps one model for every call).
 */
export function gatewayModelSlots(config: SlotRuntimeConfig): readonly AgentModelSlotDescriptor[] {
  const support = cogniaGatewaySupport(config)
  if (!support.supported) return []
  switch (support.runtime) {
    case "claude":
      return CLAUDE_SLOTS
    case "codex":
      return CODEX_SLOTS
    case "opencode":
      return config.protocol === "opencode-v2" ? OPENCODE_V2_SLOTS : OPENCODE_V1_SLOTS
    case "pi": {
      const plugin = piSubagentSupport(config)
      return plugin
        ? [
            {
              id: "subagent.default",
              kind: "child-default",
              evidence: `${plugin.family} v${plugin.version}`,
            },
          ]
        : []
    }
    default:
      return []
  }
}
