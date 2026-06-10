/**
 * The slash-command catalog for the interactive TUI. A single source of truth
 * for the composer's `/` palette and the App's command router.
 */
export interface SlashCommand {
  name: string
  aliases?: string[]
  description: string
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "model", description: "switch the model" },
  { name: "mode", description: "switch the permission mode" },
  { name: "sessions", description: "browse and resume past sessions" },
  { name: "usage", description: "show token and cost usage" },
  { name: "handoff", description: "push this session to the desktop app" },
  { name: "clear", aliases: ["new"], description: "start a fresh session" },
  { name: "help", description: "show the command list" },
  { name: "exit", aliases: ["quit"], description: "quit" },
]
