"use client"

/**
 * Status-bar segment for the integrated terminal.
 *
 * Shows how many terminals are open and whether one is running a command, and
 * toggles the dock on click. Unlike most status segments this one *is*
 * interactive — the dock is a panel the bar can reasonably own a switch for,
 * the way VS Code's status bar does.
 *
 * Returns `null` when there is nothing to say and nothing to open (no sessions
 * and no transport that could create one), so a shell without terminals does
 * not carry a dead "Terminal (0)" forever.
 */

import { TerminalIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { useTerminalTransport } from "@/hooks/terminal/use-terminal-transport"
import { cn } from "@/lib/utils"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

export function StatusBarTerminal() {
  const t = useTranslations("desktop.statusBar")
  // Narrow selectors: this renders inside a bar that is mounted on every
  // desktop route, so subscribing to the whole store would re-render it on
  // every keystroke's worth of session churn.
  const sessions = useTerminalStore((s) => s.sessions)
  const panelOpen = useTerminalStore((s) => s.panelOpen)
  const togglePanel = useTerminalStore((s) => s.togglePanel)
  const { canSpawn } = useTerminalTransport()

  const rows = Object.values(sessions)
  const count = rows.length
  const hasRunning = rows.some((row) => row.status === "running")

  if (count === 0 && !canSpawn) return null

  return (
    <button
      type="button"
      onClick={togglePanel}
      aria-pressed={panelOpen}
      aria-label={t("terminalToggle")}
      title={hasRunning ? t("terminalRunning") : t("terminalToggle")}
      data-testid="status-terminal"
      data-running={hasRunning ? "true" : "false"}
      className={cn(
        "flex h-6 items-center gap-1 px-2 text-[11px] transition-colors hover:bg-muted",
        panelOpen && "bg-muted/70"
      )}
    >
      <TerminalIcon className="size-3" aria-hidden />
      <span>{t("terminal", { count })}</span>
      {hasRunning ? (
        <span
          aria-hidden
          className="ml-0.5 inline-block size-1.5 animate-pulse rounded-full bg-amber-500"
        />
      ) : null}
    </button>
  )
}

export default StatusBarTerminal
