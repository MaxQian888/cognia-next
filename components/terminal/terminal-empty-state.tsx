"use client"

/**
 * Empty-state body for the terminal dock. Five variants:
 *
 *   * `desktop` — Tauri shell with its in-process PTY.
 *   * `remote`  — a desktop driving a remote Cognia host; new terminals open
 *     on that host, over the same `ws` frames the mobile screen uses.
 *   * `mobile`  — Capacitor shell talking to a paired desktop over LAN/WAN.
 *   * `cloud`   — a browser paired to a cognia-server (ADR-0059 C1). Same `ws`
 *     frames as `mobile`, but there is no LAN leg to explain — the pairing is
 *     an explicit server URL, so the copy must not tell the user to pair with
 *     a desktop on their network.
 *   * `unsupported` — web standalone, no server. No terminal possible.
 *
 * The action button is gated on `onNew` being supplied, not on the variant.
 * That is deliberate: the dock passes `onNew` only when a spawn is actually
 * possible (`canSpawn`), so `unsupported` ends up action-less by construction
 * rather than by a hard-coded variant check that then has to be kept in sync.
 */

import { useTranslations } from "next-intl"
import { PlusIcon, TerminalIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

export type TerminalEmptyStateVariant = "desktop" | "remote" | "mobile" | "cloud" | "unsupported"

export interface TerminalEmptyStateProps {
  variant: TerminalEmptyStateVariant
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
      {onNew ? (
        <Button size="sm" onClick={onNew} data-testid="terminal-empty-state-new">
          <PlusIcon className="mr-1 h-3 w-3" />
          {t(`${variant}.action`)}
        </Button>
      ) : null}
    </div>
  )
}

export default TerminalEmptyState
