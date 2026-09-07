"use client"

/**
 * The two reversible-versus-permanent actions on an installation, side by
 * side so the difference is visible.
 *
 * Switching a Bot off leaves everything: the config, the bindings, the
 * dead-lettered deliveries, the trigger overrides. Uninstalling drops the row
 * and the scheduler tasks its armed triggers reconciled. Putting them in the
 * same row with different weights is how a reader tells them apart before
 * clicking either.
 *
 * The switch asks to enable, and the write answers with the status that
 * actually resulted. A Bot with an unbound required slot comes back
 * `needs_setup`, so the switch settles back off rather than showing an on
 * state the row denies. That is why the checked state is derived from
 * `row.status` and never held locally.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  useBotLifecycleActions,
  useBotLifecycleReadiness,
} from "@/hooks/bots/use-bot-lifecycle-actions"
import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"

import { UninstallBotDialog } from "./uninstall-bot-dialog"

export interface BotLifecycleControlsProps {
  row: BotConsoleRow
  /** Called after the installation is gone, so the console can deselect. */
  onUninstalled?: () => void
}

export function BotLifecycleControls({ row, onUninstalled }: BotLifecycleControlsProps) {
  const t = useTranslations("bots")
  const readiness = useBotLifecycleReadiness()
  const actions = useBotLifecycleActions()
  const [confirming, setConfirming] = useState(false)

  const busy = actions.pending.has(`enabled:${row.id}`)
  // An orphan has no definition to re-derive a status against, so the write
  // refuses one. Uninstall is the exception and stays enabled: for an orphan it
  // is the only remaining action.
  const canToggle = readiness.can && !row.orphaned

  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="bot-lifecycle-controls">
      <div className="flex items-center gap-2">
        <Switch
          id={`bot-enabled-${row.id}`}
          checked={row.status === "enabled"}
          disabled={!canToggle || busy}
          onCheckedChange={(next) => void actions.setEnabled(row.id, next)}
          data-testid="bot-enabled-switch"
        />
        <Label htmlFor={`bot-enabled-${row.id}`} className="text-xs font-normal">
          {t("lifecycle.enabledLabel")}
        </Label>
      </div>

      <Button
        size="sm"
        variant="ghost"
        className="text-destructive hover:text-destructive"
        disabled={!readiness.can}
        onClick={() => setConfirming(true)}
        data-testid="bot-uninstall"
      >
        <Trash2Icon className="size-3.5" aria-hidden />
        {t("uninstall.action")}
      </Button>

      {!readiness.can ? (
        <p
          className="min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground"
          data-testid="bot-lifecycle-blocked"
        >
          {t(`write.reason.${readiness.availability.reason}`)}
        </p>
      ) : null}

      <UninstallBotDialog
        row={row}
        open={confirming}
        onOpenChange={setConfirming}
        {...(onUninstalled ? { onUninstalled } : {})}
      />
    </div>
  )
}
