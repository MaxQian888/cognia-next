/**
 * `/agent-stats` — read other coding agents' conversation histories (Claude
 * Code / Codex / OpenCode) off disk and open the aggregate statistics + analysis
 * panel. Async load runs in the agent-stats controller (see `runtime/index.ts`).
 */
import type { CommandDescriptor } from "./types"
import { rt } from "./runtime-handler"

export const AGENT_STATS_COMMANDS: CommandDescriptor[] = [
  {
    name: "agent-stats",
    aliases: ["agent-insights", "insights"],
    description:
      "Analyze other agents' conversations (Claude Code / Codex / OpenCode): usage, cost, tools",
    category: "cognia",
    handler: rt("agentStats", "open"),
  },
]
