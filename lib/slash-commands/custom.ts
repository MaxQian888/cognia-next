// Bridge between the Rust `slash_commands_scan` command and the frontend
// SlashCommand model. Custom markdown commands always end up as templates —
// their body text is the prompt; we never run them as Action handlers.

import { invoke } from "@tauri-apps/api/core"
import type { SlashCommand, SlashScope } from "./builtin"
import { applyTemplate } from "./builtin"

interface RawCommand {
  name: string
  scope: string
  path: string
  description: string | null
  argumentHint: string | null
  allowedTools: string[] | null
  model: string | null
  paths: string[] | null
  disableModelInvocation: boolean | null
  userInvocable: boolean | null
  body: string
}

/**
 * Discover custom slash commands at `<cwd>/.claude/commands/**\/*.md` and
 * `~/.claude/commands/**\/*.md`. Returns an empty list when the platform is
 * not Tauri (web-only dev mode) or both directories are missing. Errors are
 * caught and logged — a broken command file should not break the whole
 * picker.
 */
export async function loadCustomSlashCommands(
  cwd: string | null | undefined
): Promise<SlashCommand[]> {
  try {
    const raw = await invoke<RawCommand[]>("slash_commands_scan", {
      cwd: cwd ?? null,
    })
    return raw.map(toSlashCommand)
  } catch (err) {
    if (typeof window !== "undefined") {
      // The Tauri-not-detected case is the most common reason this runs in a
      // plain Next.js dev server — degrade gracefully without spamming the UI.
      console.debug("loadCustomSlashCommands skipped:", err)
    }
    return []
  }
}

function toSlashCommand(raw: RawCommand): SlashCommand {
  const scope: SlashScope =
    raw.scope === "user" ? "user" : raw.scope === "project" ? "project" : "user"
  // Either explicit user-invocable=false or disable-model-invocation=true should
  // hide the command from the picker. Pickers are the only entry point in this
  // app, so collapsing both flags into one consumer-side bool is fine.
  const hiddenFromPicker = raw.userInvocable === false || raw.disableModelInvocation === true
  return {
    name: raw.name,
    description: raw.description ?? "(custom command)",
    scope,
    argumentHint: raw.argumentHint ?? undefined,
    template: raw.body,
    filePath: raw.path,
    model: raw.model ?? undefined,
    allowedTools: raw.allowedTools ?? undefined,
    paths: raw.paths ?? undefined,
    hiddenFromPicker,
  }
}

export { applyTemplate }
