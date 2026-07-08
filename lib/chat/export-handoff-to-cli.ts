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

import { extractPlainText } from "@/lib/inbox/extract-plain-text"
import { resolveCliHome } from "@/lib/cli-bridge/home"

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
  const content = extractPlainText(message.parts)
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
