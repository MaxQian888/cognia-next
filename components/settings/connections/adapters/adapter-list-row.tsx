"use client"

/**
 * One compact row in the Adapters list (Settings → Connections → Adapters).
 *
 * Mirrors the subscription `AccountList` row language: a clickable row that
 * selects the adapter (URL-state via `useSelectedAdapter`), with secondary
 * actions tucked into a row-tail `⋮` menu instead of inline buttons. The
 * row stays quiet when the adapter is healthy and surfaces a tinted health
 * badge (reusing the same `decideBadge` predicate as the inbox badge) only
 * when it isn't. A dedicated row component is required because each row
 * calls `useAdapterHealth(row.id)`.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { InboxIcon, MoreVerticalIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

import { cn } from "@/lib/utils"
import { useAdapterHealth } from "@/hooks/connectors/use-adapter-health"
import { updateAdapterInstance } from "@/lib/db/adapter-instances"
import { removeAdapterInstance } from "@/lib/connectors/remove-adapter-instance"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

import { getAdapterTransportLabelKey, getPlatformMeta } from "./platform-meta"
import { useSelectedAdapter } from "./use-selected-adapter"
import { deriveAdapterStatus } from "./adapter-status"
import { healthReasonLabel } from "./tabs/health-reason-label"

export interface AdapterListRowProps {
  row: AdapterInstanceRow
  /** Pending + sending outbound jobs for this adapter (sidebar badge). */
  pendingCount: number
  /** Open the per-platform configuration dialog for this row. */
  onConfigure: (row: AdapterInstanceRow) => void
  /** Fired after the row selects itself — used to close the mobile drawer. */
  onAfterSelect?: () => void
}

export function AdapterListRow({
  row,
  pendingCount,
  onConfigure,
  onAfterSelect,
}: AdapterListRowProps) {
  const t = useTranslations("settings.connections.adapters")
  const tHealth = useTranslations("settings.connections.adapters.health")
  const { selectedAdapterId, setSelectedAdapterId, setActiveTab } = useSelectedAdapter()
  const [removeOpen, setRemoveOpen] = useState(false)
  const [removing, setRemoving] = useState(false)

  const selected = selectedAdapterId === row.id
  const { labelKey, Icon } = getPlatformMeta(row.type)
  const platformLabel = t(`platforms.${labelKey}`)
  const transportLabelKey = getAdapterTransportLabelKey(row.type, row.transportMode)
  const transportLabel = transportLabelKey ? t(transportLabelKey) : row.transportMode

  const health = useAdapterHealth(row.id)
  const status = deriveAdapterStatus(row.enabled, health)
  const StatusIcon = status.Icon
  const statusReason = healthReasonLabel(tHealth, status.reason)

  const onSelect = () => {
    setSelectedAdapterId(row.id)
    onAfterSelect?.()
  }

  const onToggleEnabled = () => {
    void updateAdapterInstance(row.id, { enabled: !row.enabled })
  }

  const onSendTest = () => {
    setSelectedAdapterId(row.id)
    setActiveTab("config")
  }

  const onConfirmRemove = async () => {
    setRemoving(true)
    try {
      // Shared removal path: keyring purge (desktop, best-effort) → attachment
      // cache prune (best-effort) → row + heartbeat delete. Same seam the
      // plugin API's `deleteInstance` uses, so the two can't drift.
      await removeAdapterInstance(row)
      if (selected) setSelectedAdapterId(null)
      setRemoveOpen(false)
    } catch (err) {
      // Row delete failed — the adapter is still listed, so keep the
      // selection and surface the reason instead of an unhandled rejection.
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setRemoving(false)
    }
  }

  return (
    <li className="flex items-center rounded-lg text-sm">
      <Button
        type="button"
        variant="ghost"
        data-testid={`adapter-card-${row.id}`}
        aria-pressed={selected}
        onClick={onSelect}
        className={cn(
          "h-auto min-w-0 flex-1 justify-start gap-3 rounded-lg px-3 py-2.5 text-sm transition-all duration-200",
          selected
            ? "border-l-2 border-l-primary bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
            : "hover:bg-muted/50"
        )}
      >
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md",
            selected ? "bg-primary-foreground/20" : "bg-muted text-muted-foreground"
          )}
        >
          <Icon className="size-4" aria-hidden />
        </span>

        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{row.displayName}</div>
          <div
            className={cn(
              "truncate text-[11px]",
              selected ? "text-primary-foreground/70" : "text-muted-foreground"
            )}
          >
            {platformLabel} · {transportLabel}
          </div>
        </div>

        <span
          data-testid={`adapter-row-status-${row.id}`}
          data-status={status.status}
          aria-label={t("rowHealth.aria", { state: t(status.labelKey) })}
          title={statusReason}
          className={cn(
            "flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]",
            status.tint
          )}
        >
          <StatusIcon className="size-3" aria-hidden />
          <span className="hidden sm:inline">{t(status.labelKey)}</span>
        </span>

        {pendingCount > 0 && (
          <Badge
            variant="secondary"
            className={cn(
              "shrink-0 gap-1 text-xs",
              selected && "bg-primary-foreground/20 text-primary-foreground"
            )}
            aria-label={t("pendingBadgeAria", { count: pendingCount })}
            data-testid={`adapter-pending-${row.id}`}
          >
            <InboxIcon className="h-3 w-3" aria-hidden />
            {pendingCount}
          </Badge>
        )}
      </Button>

      <div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "size-7 shrink-0",
                selected &&
                  "text-primary-foreground hover:bg-primary-foreground/20 hover:text-primary-foreground"
              )}
              aria-label={t("actions.menuAria", { name: row.displayName })}
            >
              <MoreVerticalIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onConfigure(row)}>
              {t("actions.configure")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onToggleEnabled}>
              {row.enabled ? t("actions.disable") : t("actions.enable")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onSendTest}>{t("actions.sendTest")}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => setRemoveOpen(true)}
            >
              {t("actions.remove")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("removeConfirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("removeConfirm.body", { name: row.displayName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>{t("removeConfirm.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                void onConfirmRemove()
              }}
              disabled={removing}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("removeConfirm.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  )
}
