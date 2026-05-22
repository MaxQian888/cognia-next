"use client"

/**
 * Empty-state body for the terminal dock. Two variants:
 *
 *   * `desktop` — Tauri shell with no live sessions yet. Shows a "+ New
 *     terminal" call-to-action that the dock wires up to spawnFromDock.
 *   * `mobile` — Capacitor shell. The LAN-only remote bridge (task #14)
 *     is currently a placeholder; we surface a message instead of
 *     pretending to spawn.
 *   * `unsupported` — plain browser. No terminal possible.
 */

import { useTranslations } from "next-intl"
import { PlusIcon, TerminalIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

export interface TerminalEmptyStateProps {
  variant: "desktop" | "mobile" | "unsupported"
  onNew?: () => void
}

export function TerminalEmptyState({ variant, onNew }: TerminalEmptyStateProps) {
  const t = useTranslations("terminal.emptyState")

  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 px-4 text-center"
      data-testid="terminal-empty-state"
      data-variant={variant}
    >
      <TerminalIcon className="h-8 w-8 text-muted-foreground" aria-hidden />
      <div className="space-y-1">
        <p className="text-sm font-medium">{t(`${variant}.title`)}</p>
        <p className="max-w-md text-xs text-muted-foreground">{t(`${variant}.body`)}</p>
      </div>
      {variant === "desktop" && onNew ? (
        <Button size="sm" onClick={onNew} data-testid="terminal-empty-state-new">
          <PlusIcon className="mr-1 h-3 w-3" />
          {t("desktop.action")}
        </Button>
      ) : null}
    </div>
  )
}

export default TerminalEmptyState
