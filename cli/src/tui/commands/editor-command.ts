/**
 * `/open` and `/editor` — external-editor commands.
 *
 * `/open [file[:line[:col]]]` opens a file in the configured/detected editor;
 * with no argument it opens the last file the agent referenced in the transcript
 * (via {@link lastToolFilePath}). `/editor` (bare) reports the detected editor
 * context; `/editor <command>` persists the preferred editor. Handlers are pure
 * (per the command framework): the actual spawn / env read / disk write is named
 * as an effect the App performs. See `runtime/editor.ts`.
 */
import type { CommandDescriptor, CommandEffect, CommandContext } from "./types"
import { lastToolFilePath } from "../state/selectors"

/**
 * Parse a `file[:line[:col]]` target, peeling trailing `:N` segments from the
 * end so a Windows drive colon (`C:\a.ts`) is never mistaken for a line. Only a
 * literal `:<digits>` suffix counts as a line/column.
 */
export function parseOpenTarget(arg: string): { file: string; line?: number; col?: number } {
  const trimmed = arg.trim()
  const outer = /^(.*):(\d+)$/.exec(trimmed)
  if (!outer) return { file: trimmed }
  const inner = /^(.*):(\d+)$/.exec(outer[1])
  if (inner) return { file: inner[1], line: Number(inner[2]), col: Number(outer[2]) }
  return { file: outer[1], line: Number(outer[2]) }
}

function openHandler(ctx: CommandContext): CommandEffect {
  const arg = ctx.args.trim()
  if (!arg) {
    const last = lastToolFilePath(ctx.state)
    if (!last) {
      return {
        kind: "notice",
        message: "No file to open yet — pass a path (/open <file>) or reference one in the chat.",
      }
    }
    return { kind: "openFile", file: last.path, line: last.line }
  }
  const { file, line, col } = parseOpenTarget(arg)
  if (!file) return { kind: "notice", message: "Usage: /open <file>[:line[:col]]" }
  return { kind: "openFile", file, line, col }
}

function editorHandler(ctx: CommandContext): CommandEffect {
  const arg = ctx.args.trim()
  if (!arg) return { kind: "editorInfo" }
  return { kind: "setEditor", command: arg }
}

export const openCommand: CommandDescriptor = {
  name: "open",
  description: "open a file in your editor (defaults to the last file referenced)",
  category: "system",
  argumentHint: "[file[:line[:col]]]",
  handler: openHandler,
}

export const editorCommand: CommandDescriptor = {
  name: "editor",
  description: "show the detected editor, or set it (/editor <command>)",
  category: "system",
  argumentHint: "[command]",
  handler: editorHandler,
}

/** Both editor commands, registered together in the core registry. */
export const editorCommands: CommandDescriptor[] = [openCommand, editorCommand]
