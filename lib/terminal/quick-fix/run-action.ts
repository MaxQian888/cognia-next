"use client"

/**
 * Perform a chosen quick-fix action.
 *
 * Extracted from `terminal-instance.tsx` so the dispatch has a test: reaching
 * it through the component means driving a command-end event with matching
 * output through xterm, and the one branch that most needed covering was the
 * one that silently did nothing.
 *
 * That branch is `kill-port`. It called `invoke("terminal_kill_port")`
 * directly, which only exists on this machine — but over `ws` / `webrtc` the
 * busy port belongs to the *host* that ran the command. In a browser the fix
 * resolved without doing anything and then re-ran the command straight back
 * into the same occupied port. `killTerminalPort` routes to whichever host
 * that is; the routed twin had existed in `remote-api.ts` the whole time with
 * no callers.
 */

import type { QuickFixAction } from "./matchers"

export interface QuickFixEffects {
  /** Write into the session's PTY. */
  write: (data: string) => void
  /** Open a URL through the OSC 8 allowlist. */
  openUrl: (url: string) => void
  /** Free a TCP port on the host that owns it. */
  killPort: (port: number) => Promise<unknown>
}

/**
 * Run `action`. Never throws — a quick fix that fails must not take the
 * terminal down with it, and the user can always run the command by hand.
 */
export async function runQuickFixAction(
  action: QuickFixAction,
  effects: QuickFixEffects
): Promise<void> {
  try {
    switch (action.type) {
      case "run-command":
        // `addNewLine` is the matcher's call: deterministic fixes auto-run,
        // suggestion-derived ones wait for the user to press enter.
        effects.write(action.command + (action.addNewLine ? "\r" : ""))
        return
      case "open-url":
        effects.openUrl(action.url)
        return
      case "kill-port":
        await effects.killPort(action.port)
        // Only after the port is actually free — re-running first would just
        // reproduce the error the fix exists to clear.
        effects.write(action.command + "\r")
        return
    }
  } catch {
    // Best-effort by design; see the note above.
  }
}
