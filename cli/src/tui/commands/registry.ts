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
  { name: "config", aliases: ["settings"], description: "open the settings panel" },
  { name: "provider", description: "switch the AI provider" },
  { name: "model", description: "switch the model" },
  { name: "mode", description: "switch the permission mode" },
  { name: "sessions", description: "browse and resume past sessions" },
  { name: "usage", aliases: ["cost"], description: "show token and cost usage" },
  { name: "retry", aliases: ["resend"], description: "re-send the last message" },
  { name: "copy", description: "copy the last reply to the clipboard" },
  { name: "tools", description: "list the enabled built-in tools" },
  { name: "cwd", description: "show the working directory" },
  { name: "about", aliases: ["version"], description: "show version and provider info" },
  { name: "handoff", description: "push this session to the desktop app" },
  { name: "clear", aliases: ["new"], description: "start a fresh session" },
  { name: "help", description: "show the command list" },
  { name: "exit", aliases: ["quit"], description: "quit" },
]
