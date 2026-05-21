"use client"

// Compact one-row-per-plugin renderer used by the Library list view.
// Mirrors the affordances of PluginCard (selection checkbox + click-to-
// detail + status pill + capability chips + actions menu) but packs the
// content into a single horizontal row so users can browse 50+ plugins
// without scrolling forever. Action set is shared with PluginCard via
// PluginRowActionsMenu so the two views can't drift.

import { useTranslations } from "next-intl"
import { CircleAlertIcon, ShieldCheckIcon } from "lucide-react"
import type { PluginRow } from "@/lib/db/plugin-types"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"
import { PluginRowActionsMenu } from "../plugin-row-actions-menu"
import { PluginSignatureBadge, type SignatureState } from "../plugin-signature-badge"
import { PluginStatusPill } from "../plugin-status-badge"

interface Props {
  plugin: PluginRow
  selected: boolean
  active: boolean
  onToggleSelect: (id: string) => void
  onOpen: (id: string) => void
  onConfigure: (id: string) => void
  onToggleEnabled: (plugin: PluginRow) => void
  onUninstall: (plugin: PluginRow) => void
  onReviewPermissions: (id: string) => void
  onRollback?: (id: string) => void
}

export function PluginLibraryRow({
  plugin,
  selected,
  active,
  onToggleSelect,
  onOpen,
  onConfigure,
  onToggleEnabled,
  onUninstall,
  onReviewPermissions,
  onRollback,
}: Props) {
  const t = useTranslations("plugins.card")
  const errored = plugin.status === "error"
  const isLoading =
    plugin.status === "loading" || plugin.status === "enabling" || plugin.status === "updating"
  const signatureState: SignatureState = (() => {
    const sig = (plugin.manifest as { signature?: { verified?: boolean; failed?: boolean } })
      ?.signature
    if (sig?.verified) return "verified"
    if (sig?.failed) return "failed"
    return "unverified"
  })()
  const updateAvailable = !!(plugin.manifest as { updateAvailable?: boolean })?.updateAvailable
  const permissionCount = (plugin.manifest as { permissions?: string[] })?.permissions?.length ?? 0

  return (
    <div
      className={cn(
        "group flex items-center gap-2 border-b px-2 py-1.5 text-sm",
        "transition-colors hover:bg-accent/40",
        active && "bg-accent/60",
        !plugin.enabled && "opacity-70",
        errored && "border-l-2 border-l-destructive/60"
      )}
      data-plugin-id={plugin.id}
      data-active={active}
    >
      <Checkbox
        checked={selected}
        onCheckedChange={() => onToggleSelect(plugin.id)}
        aria-label={t("selectAria", { name: plugin.name })}
        className="shrink-0"
      />
      <button
        type="button"
        onClick={() => onOpen(plugin.id)}
        className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-ring"
        data-testid={`plugin-library-row-${plugin.id}`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="font-medium truncate">{plugin.name}</span>
            <span className="text-xs text-muted-foreground shrink-0">v{plugin.version}</span>
            {updateAvailable && (
              <Badge variant="secondary" className="text-xs shrink-0">
                {t("updateBadge")}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground truncate">
            <span className="truncate">{plugin.id}</span>
            {errored && plugin.error && (
              <span className="flex items-center gap-0.5 text-destructive shrink-0">
                <CircleAlertIcon className="size-3" />
                <span className="line-clamp-1">{plugin.error}</span>
              </span>
            )}
          </div>
        </div>
        <div className="hidden items-center gap-1 lg:flex">
          {plugin.capabilities.slice(0, 3).map((cap) => (
            <Badge key={cap} variant="outline" className="text-xs">
              {cap}
            </Badge>
          ))}
          {plugin.capabilities.length > 3 && (
            <Badge variant="outline" className="text-xs">
              +{plugin.capabilities.length - 3}
            </Badge>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {permissionCount > 0 && (
            <span className="hidden md:flex items-center gap-1 text-xs text-muted-foreground">
              <ShieldCheckIcon className="size-3" />
              {permissionCount}
            </span>
          )}
          <PluginSignatureBadge state={signatureState} compact />
          <PluginStatusPill status={plugin.status} enabled={plugin.enabled} loading={isLoading} />
        </div>
      </button>
      <PluginRowActionsMenu
        plugin={plugin}
        onOpen={onOpen}
        onConfigure={onConfigure}
        onToggleEnabled={onToggleEnabled}
        onUninstall={onUninstall}
        onReviewPermissions={onReviewPermissions}
        onRollback={onRollback}
        triggerClassName="size-6 shrink-0"
      />
    </div>
  )
}
