/**
 * Built-in head-word completion provider (ADR-0039 phase 2): completes the
 * *command name* — the first token of the line — from PATH executables
 * (Rust scan, desktop only) merged with the shell's builtin commands
 * (static lists, work everywhere).
 *
 * Only fires while the cursor is still inside the head word; arguments are
 * the path/spec providers' turf.
 */

import { isTauri } from "@/lib/tauri"
import { shellBuiltins } from "./shell-builtins"
import { tokenAtCursor } from "./tokenize"
import type { TerminalCompletionProvider, TerminalCompletionSuggestion } from "./types"

const MAX_EXE_SUGGESTIONS = 8

export interface ExeProviderDeps {
  /** Tauri invoke — injected for tests. */
  invoke?: (cmd: string, args: Record<string, unknown>) => Promise<unknown>
  /** Platform gate — injected for tests. */
  isDesktop?: () => boolean
}

/** Build the provider (deps injectable for tests). */
export function createExeCompletionProvider(
  deps: ExeProviderDeps = {}
): TerminalCompletionProvider {
  const isDesktop = deps.isDesktop ?? isTauri
  const doInvoke =
    deps.invoke ??
    (async (cmd: string, args: Record<string, unknown>) => {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke(cmd, args)
    })

  return {
    id: "builtin:exe",
    label: "Command names",
    priority: 30,
    getCompletions: async (context, signal) => {
      const at = tokenAtCursor(context.input, context.cursor)
      if (!at || at.index !== 0) return []
      const prefix = at.token.value
      // A bare prefix only — paths (./x, /bin/x, ~/x) are the path
      // provider's job, and an empty head has nothing to rank on.
      if (prefix.length === 0) return []
      if (/[/\\~.]/.test(prefix)) return []

      const prefixLower = prefix.toLowerCase()
      const builtins = shellBuiltins(context.shell).filter((b) =>
        b.toLowerCase().startsWith(prefixLower)
      )

      let exes: string[] = []
      if (isDesktop()) {
        try {
          const result = (await doInvoke("terminal_list_path_executables", {
            prefix,
            limit: MAX_EXE_SUGGESTIONS * 2,
          })) as unknown
          exes = Array.isArray(result) ? (result as string[]) : []
        } catch {
          exes = []
        }
      }
      if (signal.aborted) return []

      // Builtins first (they shadow PATH entries in a real shell), then
      // PATH executables; dedupe case-insensitively, builtin casing wins.
      const seen = new Set<string>()
      const merged: string[] = []
      for (const name of [...builtins, ...exes]) {
        const key = name.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        merged.push(name)
        if (merged.length >= MAX_EXE_SUGGESTIONS) break
      }

      return merged
        .filter((name) => name !== prefix)
        .map((name, i): TerminalCompletionSuggestion => ({
          text: name,
          source: "exe",
          providerId: "builtin:exe",
          score: Math.max(0.1, 0.85 - i * 0.05),
          replace: { from: at.token.start, insert: name },
        }))
    },
  }
}
