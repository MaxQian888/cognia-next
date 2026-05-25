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
import { CircleIcon, InboxIcon, MoreVerticalIcon } from "lucide-react"

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
import { isTauri } from "@/lib/tauri"
import { useAdapterHealth } from "@/hooks/connectors/use-adapter-health"
import { deleteAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { connectorsKeyringDelete } from "@/lib/connectors/tauri/commands"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

import { getPlatformMeta } from "./platform-meta"
import { useSelectedAdapter } from "./use-selected-adapter"
import {
  decideBadge,
  STATE_ICON,
  STATE_TINT,
  type BadgeState,
} from "@/components/inbox/adapter-health-decision"

const HEALTH_LABEL_KEY: Record<BadgeState, string> = {
  "breaker-open": "rowHealth.breakerOpen",
  "rate-limited": "rowHealth.rateLimited",
  degraded: "rowHealth.degraded",
  down: "rowHealth.down",
}

export interface AdapterListRowProps {
  row: AdapterInstanceRow
  /** Pending + sending outbound jobs for this adapter (sidebar badge). */
  pendingCount: number
  /** Open the per-platform configuration dialog for this row. */
  onConfigure: (row: AdapterInstanceRow) => void
}

export function AdapterListRow({ row, pendingCount, onConfigure }: AdapterListRowProps) {
  const t = useTranslations("settings.connections.adapters")
  const { selectedAdapterId, setSelectedAdapterId, setActiveTab } = useSelectedAdapter()
  const [removeOpen, setRemoveOpen] = useState(false)
  const [removing, setRemoving] = useState(false)

  const selected = selectedAdapterId === row.id
  const { labelKey, Icon } = getPlatformMeta(row.type)
  const platformLabel = t(`platforms.${labelKey}`)

  const health = useAdapterHealth(row.id)
  const decision = decideBadge(health)

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
      // `deleteAdapterInstance` removes the row + heartbeats but NOT the
      // keyring secrets — clear those here so credentials don't outlive the
      // adapter. Desktop-only (keyring is a Tauri command); best-effort so a
      // single failed credential never blocks the delete.
      if (isTauri()) {
        for (const account of row.credentialsRef.accounts) {
          try {
            await connectorsKeyringDelete(row.id, account)
          } catch {
            // ignore — credential may already be gone
          }
        }
      }
      await deleteAdapterInstance(row.id)
      if (selected) setSelectedAdapterId(null)
      setRemoveOpen(false)
    } finally {
      setRemoving(false)
    }
  }

  const HealthIcon = decision ? STATE_ICON[decision.state] : null

  return (
    <li
      role="button"
      aria-pressed={selected}
      data-testid={`adapter-card-${row.id}`}
      onClick={() => setSelectedAdapterId(row.id)}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded border bg-card/40 px-2.5 py-2 text-sm transition-colors",
        selected ? "border-primary bg-primary/5" : "hover:border-muted-foreground/40"
      )}
    >
      <span className="relative flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-4" aria-hidden />
        <CircleIcon
          aria-hidden
          className={cn(
            "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full fill-current stroke-background stroke-[3px]",
            row.enabled ? "text-emerald-500" : "text-muted-foreground"
          )}
        />
      </span>

      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{row.displayName}</div>
        <div className="truncate text-[11px] text-muted-foreground">
          {platformLabel} · {row.transportMode}
        </div>
      </div>

      {decision && HealthIcon && (
        <span
          data-testid={`adapter-row-health-${row.id}`}
          aria-label={t("rowHealth.aria", { state: t(HEALTH_LABEL_KEY[decision.state]) })}
          className={cn(
            "flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]",
            STATE_TINT[decision.state]
          )}
        >
          <HealthIcon className="size-3" aria-hidden />
          {t(HEALTH_LABEL_KEY[decision.state])}
        </span>
      )}

      {pendingCount > 0 && (
        <Badge
          variant="secondary"
          className="shrink-0 gap-1 text-xs"
          aria-label={t("pendingBadgeAria", { count: pendingCount })}
          data-testid={`adapter-pending-${row.id}`}
        >
          <InboxIcon className="h-3 w-3" aria-hidden />
          {pendingCount}
        </Badge>
      )}

      <span onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
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
      </span>

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
