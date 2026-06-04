/**
 * Built-in file/directory path completion provider (ADR-0039 phase 2).
 *
 * Completes the token under the cursor against the session cwd (tracked
 * via OSC 633 P) by asking the Rust side to list + prefix-filter the
 * directory (`terminal_complete_paths`). Desktop-only: in web/Capacitor
 * mode (`!isTauri()`) or before the first cwd event it returns nothing.
 *
 * Suggestions are emitted in *replace* mode spanning the whole token, so
 * accepting can re-case (`doc` → `Documents\`) and re-quote
 * (`My F` → `"My Folder\`) safely — the controller erases the typed span
 * with DEL bytes and writes the rebuilt token.
 */

import { isTauri } from "@/lib/tauri"
import type { ShellKind } from "@/lib/terminal/shell-detect"
import { shellUsesBackslashEscapes, tokenAtCursor } from "./tokenize"
import type { TerminalCompletionProvider, TerminalCompletionSuggestion } from "./types"

const MAX_PATH_SUGGESTIONS = 8

interface PathCandidate {
  name: string
  isDir: boolean
}

export interface PathProviderDeps {
  /** Tauri invoke — injected for tests. */
  invoke?: (cmd: string, args: Record<string, unknown>) => Promise<unknown>
  /** Platform gate — injected for tests. */
  isDesktop?: () => boolean
}

/** Does this token look like the user is typing a path? */
function looksPathLike(value: string): boolean {
  return (
    value.includes("/") || value.includes("\\") || value.startsWith(".") || value.startsWith("~")
  )
}

/** The directory part of the fragment (trailing separator kept). */
function splitFragment(fragment: string): { dirPart: string; prefix: string } {
  const idx = Math.max(fragment.lastIndexOf("/"), fragment.lastIndexOf("\\"))
  if (idx < 0) return { dirPart: "", prefix: fragment }
  return { dirPart: fragment.slice(0, idx + 1), prefix: fragment.slice(idx + 1) }
}

/** Separator to append after a completed directory. */
function dirSeparator(fragment: string, shell: ShellKind): string {
  if (fragment.includes("\\") && !shellUsesBackslashEscapes(shell)) return "\\"
  if (fragment.includes("/")) return "/"
  switch (shell) {
    case "pwsh":
    case "powershell":
    case "cmd":
      return "\\"
    default:
      return "/"
  }
}

/**
 * Turn the completed token *value* back into typeable raw text: POSIX
 * shells get `\ `-escaped spaces/quotes; Windows-style shells get a
 * double-quote wrap (left open for directories so typing continues
 * inside the quotes, closed for files).
 */
export function requoteToken(value: string, shell: ShellKind, isDir: boolean): string {
  if (!/[\s"']/.test(value)) return value
  if (shellUsesBackslashEscapes(shell)) {
    return value.replace(/([ '"])/g, "\\$1")
  }
  const inner = value.replace(/"/g, '""')
  return isDir ? `"${inner}` : `"${inner}"`
}

/** Build the provider (deps injectable for tests). */
export function createPathCompletionProvider(
  deps: PathProviderDeps = {}
): TerminalCompletionProvider {
  const isDesktop = deps.isDesktop ?? isTauri
  const doInvoke =
    deps.invoke ??
    (async (cmd: string, args: Record<string, unknown>) => {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke(cmd, args)
    })

  return {
    id: "builtin:path",
    label: "File paths",
    priority: 20,
    getCompletions: async (context, signal) => {
      if (!isDesktop()) return []
      if (!context.cwd) return []

      const escapes = shellUsesBackslashEscapes(context.shell)
      const at = tokenAtCursor(context.input, context.cursor, { backslashEscapes: escapes })
      if (!at) return []
      const { token, index } = at

      // Head word is the *command* — that's the exe provider's turf unless
      // the user is clearly typing a path (./script.sh, ../bin/x, ~/x).
      if (index === 0 && !looksPathLike(token.value)) return []
      // Never complete a fresh argument for an empty line.
      if (index === 0 && token.value.length === 0) return []

      const fragment = token.value
      const { dirPart } = splitFragment(fragment)

      let candidates: PathCandidate[]
      try {
        candidates = (await doInvoke("terminal_complete_paths", {
          cwd: context.cwd,
          fragment,
          showHidden: false,
          limit: MAX_PATH_SUGGESTIONS * 2,
        })) as PathCandidate[]
      } catch {
        return []
      }
      if (signal.aborted || !Array.isArray(candidates)) return []

      const sep = dirSeparator(fragment, context.shell)
      const out: TerminalCompletionSuggestion[] = []
      for (const c of candidates.slice(0, MAX_PATH_SUGGESTIONS)) {
        // Skip the no-op candidate (token already exactly this entry).
        const completedValue = dirPart + c.name + (c.isDir ? sep : "")
        if (completedValue === fragment) continue
        const insert = requoteToken(completedValue, context.shell, c.isDir)
        const text = context.input.slice(0, token.start) + insert
        out.push({
          text,
          source: "path",
          providerId: "builtin:path",
          detail: c.isDir ? "dir" : "file",
          score: Math.max(0.1, 0.9 - out.length * 0.05),
          replace: { from: token.start, insert },
        })
      }
      return out
    },
  }
}
