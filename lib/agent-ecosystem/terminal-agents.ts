/** User-operated native CLIs, deliberately separate from structured chat runtimes. */
export const TERMINAL_AGENTS = [
  {
    id: "freebuff",
    name: "Freebuff",
    command: "freebuff",
    args: [],
    docsUrl: "https://freebuff.com/cli",
  },
  {
    id: "zcode",
    name: "ZCode",
    command: "zcode",
    args: [],
    docsUrl: "https://zcode.z.ai/en/docs/agents",
  },
] as const

export type TerminalAgentDefinition = (typeof TERMINAL_AGENTS)[number]
export type TerminalAgentId = TerminalAgentDefinition["id"]

export function findTerminalAgent(id: string): TerminalAgentDefinition | undefined {
  return TERMINAL_AGENTS.find((agent) => agent.id === id)
}

/** Stable native-host profile identity survives renderer reload/reattachment. */
export function terminalAgentProfileId(id: TerminalAgentId): string {
  return `cognia-agent-terminal-${id}`
}
