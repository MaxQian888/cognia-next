/**
 * Tool calls from a stored conversation, normalized across runtimes
 * (ADR-0238 §8.1).
 *
 * The adherence backtest asks "did the agent do what the rule says?", which is
 * only answerable from tool calls: Cognia's own (`bash`, `edit`, `write`),
 * Claude Code's (`Bash`, `Edit`, `MultiEdit`), Codex's (`shell`,
 * `apply_patch`) and MCP-namespaced variants all reduce to a tool family, a
 * command line and the paths touched. Turns are split at user messages, which
 * is where a "within the turn" rule's window ends.
 */

export type ToolFamily = "shell" | "edit" | "read" | "other"

export interface ToolEvent {
  sessionId: string
  messageId: string
  /** 0-based index of the user turn the call belongs to. */
  turn: number
  /** Position in the session, for ordering. */
  order: number
  family: ToolFamily
  tool: string
  command?: string
  paths: string[]
}

export interface SessionEvents {
  sessionId: string
  /** Number of user turns. */
  turns: number
  events: ToolEvent[]
}

/** The message shape the host stores (`UIMessage`), reduced to what is read. */
export interface StoredMessageLike {
  id: string
  role: string
  parts?: ReadonlyArray<Record<string, unknown>>
}

const SHELL = new Set([
  "bash",
  "shell",
  "local_shell",
  "execute_command",
  "run_command",
  "run_terminal_cmd",
  "terminal",
  "exec_command",
  "powershell",
])
const EDIT = new Set([
  "edit",
  "multiedit",
  "multi_edit",
  "write",
  "write_file",
  "create_file",
  "edit_file",
  "str_replace",
  "str_replace_editor",
  "str_replace_based_edit_tool",
  "apply_patch",
  "notebookedit",
  "notebook_edit",
  "replace_in_file",
])
const READ = new Set(["read", "read_file", "view", "view_file", "cat", "open_file"])

/** `mcp__server__tool` and `server.tool` forms reduce to the tool's own name. */
export function baseToolName(name: string): string {
  const mcp = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(name)
  const bare = mcp ? mcp[1]! : name
  return (bare.split(".").pop() ?? bare).toLowerCase()
}

export function toolFamily(name: string): ToolFamily {
  const base = baseToolName(name)
  if (SHELL.has(base)) return "shell"
  if (EDIT.has(base)) return "edit"
  if (READ.has(base)) return "read"
  return "other"
}

function commandOf(input: Record<string, unknown>): string | undefined {
  const value = input.command ?? input.cmd ?? input.script
  if (typeof value === "string") return value
  if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
    // Codex sends argv; `bash -lc "<line>"` carries the real command last.
    const argv = value as string[]
    if (argv.length >= 3 && /^(?:ba|z)?sh$/.test(argv[0]!) && /^-\w*c$/.test(argv[1]!)) {
      return argv.slice(2).join(" ")
    }
    return argv.join(" ")
  }
  return undefined
}

const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm

function pathsOf(input: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const key of ["file_path", "filePath", "path", "notebook_path", "target_file", "filename"]) {
    const value = input[key]
    if (typeof value === "string" && value) out.push(value)
  }
  const edits = input.edits
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (edit && typeof edit === "object") {
        const path =
          (edit as Record<string, unknown>).file_path ?? (edit as Record<string, unknown>).path
        if (typeof path === "string") out.push(path)
      }
    }
  }
  const patch = input.patch ?? input.input
  if (typeof patch === "string") {
    for (const match of patch.matchAll(PATCH_FILE)) out.push(match[1]!.trim())
  }
  return [...new Set(out)]
}

function toolPartName(part: Record<string, unknown>): string | undefined {
  const type = typeof part.type === "string" ? part.type : ""
  if (type === "dynamic-tool" && typeof part.toolName === "string") return part.toolName
  if (type.startsWith("tool-")) return type.slice("tool-".length)
  return undefined
}

function inputOf(part: Record<string, unknown>): unknown {
  return part.input ?? part.args
}

export interface NormalizedToolCall {
  family: ToolFamily
  tool: string
  command?: string
  paths: string[]
}

/** One tool call's family, command line and paths, from its name and input. */
export function normalizeToolCall(tool: string, rawInput: unknown): NormalizedToolCall {
  const input =
    rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : {}
  const command = commandOf(input)
  return { family: toolFamily(tool), tool, ...(command ? { command } : {}), paths: pathsOf(input) }
}

export function extractSessionEvents(
  sessionId: string,
  messages: readonly StoredMessageLike[]
): SessionEvents {
  const events: ToolEvent[] = []
  let turn = -1
  let order = 0
  for (const message of messages) {
    if (message.role === "user") {
      turn++
      continue
    }
    if (message.role !== "assistant") continue
    for (const part of message.parts ?? []) {
      const tool = toolPartName(part)
      if (!tool) continue
      events.push({
        sessionId,
        messageId: message.id,
        turn: Math.max(turn, 0),
        order: order++,
        ...normalizeToolCall(tool, inputOf(part)),
      })
    }
  }
  return { sessionId, turns: Math.max(turn + 1, events.length > 0 ? 1 : 0), events }
}
