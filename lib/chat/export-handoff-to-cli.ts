/**
 * Desktop → CLI handoff (the reverse direction).
 *
 * Writes a session's transcript to `<cli-home>/handoff/<sessionId>.jsonl` — the
 * drop file `cognia-agent resume <id>` reads — and returns the resume command
 * for the UI to surface (copy / toast). Uses `@tauri-apps/api/path` + the
 * existing `ensureDir`/`writeTextFile` Tauri commands, so it needs no new Rust
 * surface. Filesystem + path collaborators are injected for unit tests.
 *
 * The CLI home is resolved via {@link resolveCliHome} (the Rust
 * `resolve_cli_home` command), which honours `$COGNIA_HOME` and falls back to
 * `~/.cognia` itself — so a CLI started with an overridden home still sees the
 * drop. When it can't be resolved we throw rather than guessing `~/.cognia`,
 * which would silently drop the transcript in the wrong home.
 */

import type { UIMessage } from "ai"

import { resolveCliHome } from "@/lib/cli-bridge/home"

const HANDOFF_MARKER_MAX_LENGTH = 240

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function oneLine(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim()
  try {
    return JSON.stringify(value).replace(/\s+/g, " ").trim()
  } catch {
    return String(value).replace(/\s+/g, " ").trim()
  }
}

function boundedMarker(prefix: string, detail?: unknown): string {
  const suffix = detail === undefined ? "" : ` ${oneLine(detail)}`
  const marker = `${prefix}${suffix}`
  return marker.length <= HANDOFF_MARKER_MAX_LENGTH
    ? marker
    : `${marker.slice(0, HANDOFF_MARKER_MAX_LENGTH - 1)}…`
}

function boundedDetail(value: unknown, max = 96): string {
  const detail = oneLine(value)
  return detail.length <= max ? detail : `${detail.slice(0, max - 1)}…`
}

function toolMarker(part: Record<string, unknown>, type: string): string {
  const name =
    type === "dynamic-tool"
      ? stringValue(part.toolName) || "tool"
      : type.startsWith("tool-")
        ? type.slice("tool-".length)
        : stringValue(part.name) || "tool"
  const details: string[] = []
  if (part.input !== undefined) details.push(`input: ${boundedDetail(part.input)}`)
  if (part.output !== undefined) details.push(`result: ${boundedDetail(part.output)}`)
  if (typeof part.errorText === "string" && part.errorText) {
    details.push(`error: ${boundedDetail(part.errorText)}`)
  }
  return boundedMarker(`[tool: ${name}]`, details.join("; ") || part.state)
}

/**
 * Render rich UI message parts into the text preamble consumed by
 * `cognia-agent resume`. Known rich parts receive concise markers and unknown
 * future parts receive a type marker, so handoff never loses their existence
 * silently. Tool/reasoning markers are bounded; code remains fenced verbatim.
 */
export function serializeHandoffParts(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  const rendered: string[] = []
  for (const raw of parts) {
    if (!isRecord(raw)) {
      rendered.push("[part: invalid]")
      continue
    }
    const type = stringValue(raw.type) || "unknown"
    if (type === "text") {
      const text = stringValue(raw.text).trim()
      if (text) rendered.push(text)
    } else if (type === "markdown") {
      const markdown = stringValue(raw.md) || stringValue(raw.text)
      if (markdown.trim()) rendered.push(markdown.trim())
    } else if (type === "code") {
      const code = stringValue(raw.code) || stringValue(raw.text)
      if (code) rendered.push(`\`\`\`${stringValue(raw.language)}\n${code}\n\`\`\``)
    } else if (type === "reasoning" || type === "thinking") {
      const reasoning = stringValue(raw.text) || stringValue(raw.thinking)
      rendered.push(boundedMarker("[reasoning]", reasoning || undefined))
    } else if (type.startsWith("tool-") || type === "dynamic-tool" || type === "tool_use") {
      rendered.push(toolMarker(raw, type))
    } else if (type === "tool_result") {
      rendered.push(boundedMarker("[tool result]", raw.content ?? raw.output))
    } else if (type === "file") {
      const filename =
        stringValue(raw.filename) ||
        stringValue(raw.fileName) ||
        stringValue(raw.mediaType) ||
        "file"
      rendered.push(boundedMarker(`[attachment: ${filename}]`))
    } else if (type === "image") {
      const alt = stringValue(raw.alt)
      rendered.push(boundedMarker(alt ? `[image: ${alt}]` : "[image]"))
    } else if (type === "a2ui") {
      const mirror = stringValue(raw.plainTextMirror) || stringValue(raw.text)
      rendered.push(boundedMarker("[a2ui]", mirror || undefined))
    } else {
      rendered.push(boundedMarker(`[part: ${type}]`))
    }
  }
  return rendered.join("\n").trim()
}

export interface ExportHandoffDeps {
  /**
   * Resolve the cognia CLI home (`$COGNIA_HOME` or `~/.cognia`). Defaults to
   * {@link resolveCliHome} so a `$COGNIA_HOME` override is honoured; falls back
   * to `homeDir()` + `.cognia` when it returns null (e.g. mid-test).
   */
  resolveHome?: () => Promise<string | null>
  /** Join path segments (defaults to @tauri-apps/api/path join). */
  join?: (...parts: string[]) => Promise<string>
  /** Ensure a directory exists (defaults to the ensureDir Tauri command). */
  ensureDir?: (dir: string) => Promise<void>
  /** Write a file (defaults to the writeTextFile Tauri command). */
  writeTextFile?: (path: string, content: string) => Promise<void>
  now?: () => number
}

export interface ExportHandoffParams {
  sessionId: string
  messages: UIMessage[]
}

export interface ExportHandoffResult {
  /** Absolute path of the written drop file. */
  path: string
  /** The command the user runs to continue in a terminal. */
  command: string
}

/** Render a UIMessage to a transcript JSONL line (matches the CLI's reader). */
function toLine(message: UIMessage, ts: number): string | null {
  const content = serializeHandoffParts(message.parts)
  if (!content) return null
  const role = message.role === "assistant" || message.role === "system" ? message.role : "user"
  return JSON.stringify({ ts, role, content })
}

async function defaultJoin(...parts: string[]): Promise<string> {
  const { join } = await import("@tauri-apps/api/path")
  return join(...parts)
}

/**
 * Serialize + drop the transcript, returning the resume command. Throws if the
 * session has no renderable messages.
 */
export async function exportHandoffToCli(
  params: ExportHandoffParams,
  deps: ExportHandoffDeps = {}
): Promise<ExportHandoffResult> {
  const join = deps.join ?? defaultJoin
  const now = deps.now ?? Date.now

  const baseTs = now()
  const lines = params.messages
    .map((m, i) => toLine(m, baseTs + i))
    .filter((l): l is string => l !== null)
  if (lines.length === 0) {
    throw new Error("export handoff: session has no text to hand off")
  }

  // Resolve the CLI home via the COGNIA_HOME-aware resolver. It already falls
  // back to `~/.cognia` on its own, so a null here means it genuinely couldn't
  // be resolved (outside Tauri, or a Rust-command failure). Guessing `~/.cognia`
  // ourselves would silently mis-write when $COGNIA_HOME is set, so throw.
  const resolveHome = deps.resolveHome ?? resolveCliHome
  const cogniaHome = await resolveHome()
  if (!cogniaHome) {
    throw new Error("export handoff: could not resolve the cognia CLI home directory")
  }
  const dir = await join(cogniaHome, "handoff")
  const path = await join(dir, `${params.sessionId}.jsonl`)

  // Confine the drop to the `.cognia` home so a crafted sessionId (e.g. one
  // containing `../`) can't write the transcript outside the handoff tree.
  const ensureDir =
    deps.ensureDir ??
    (async (d: string) => (await import("@/lib/claude/ipc")).ensureDirConfined(d, [cogniaHome]))
  const writeTextFile =
    deps.writeTextFile ??
    (async (p: string, c: string) =>
      (await import("@/lib/claude/ipc")).writeTextFileConfined(p, c, [cogniaHome]))

  await ensureDir(dir)
  await writeTextFile(path, lines.join("\n") + "\n")

  return { path, command: `cognia-agent resume ${params.sessionId}` }
}
