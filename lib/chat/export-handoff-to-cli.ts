/**
 * Desktop → CLI handoff (the reverse direction).
 *
 * Writes a session's transcript to `~/.cognia/handoff/<sessionId>.jsonl` — the
 * drop file `cognia-agent resume <id>` reads — and returns the resume command
 * for the UI to surface (copy / toast). Uses `@tauri-apps/api/path` + the
 * existing `ensureDir`/`writeTextFile` Tauri commands, so it needs no new Rust
 * surface. Filesystem + path collaborators are injected for unit tests.
 *
 * Note: targets the default CLI home (`~/.cognia`). A CLI started with a
 * `$COGNIA_HOME` override won't see this drop — acceptable for v1.
 */

import type { UIMessage } from "ai"

import { extractPlainText } from "@/lib/inbox/extract-plain-text"

export interface ExportHandoffDeps {
  /** Resolve the OS home dir (defaults to @tauri-apps/api/path homeDir). */
  homeDir?: () => Promise<string>
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
  const content = extractPlainText(message.parts)
  if (!content) return null
  const role = message.role === "assistant" || message.role === "system" ? message.role : "user"
  return JSON.stringify({ ts, role, content })
}

async function defaultHomeDir(): Promise<string> {
  const { homeDir } = await import("@tauri-apps/api/path")
  return homeDir()
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
  const homeDir = deps.homeDir ?? defaultHomeDir
  const join = deps.join ?? defaultJoin
  const now = deps.now ?? Date.now

  const baseTs = now()
  const lines = params.messages
    .map((m, i) => toLine(m, baseTs + i))
    .filter((l): l is string => l !== null)
  if (lines.length === 0) {
    throw new Error("export handoff: session has no text to hand off")
  }

  const home = await homeDir()
  const dir = await join(home, ".cognia", "handoff")
  const path = await join(dir, `${params.sessionId}.jsonl`)

  const ensureDir =
    deps.ensureDir ?? (async (d: string) => (await import("@/lib/claude/ipc")).ensureDir(d))
  const writeTextFile =
    deps.writeTextFile ??
    (async (p: string, c: string) => (await import("@/lib/claude/ipc")).writeTextFile(p, c))

  await ensureDir(dir)
  await writeTextFile(path, lines.join("\n") + "\n")

  return { path, command: `cognia-agent resume ${params.sessionId}` }
}
