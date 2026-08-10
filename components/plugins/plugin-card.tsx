"use client"

// Rich card replacing the table row in the InstalledTab. Surfaces version,
// capability chips, permission count, status, signature status, and an
// action menu (open / configure / enable-disable / uninstall). Mirrors the
// shape of `components/skills/skill-card.tsx` so future shared treatments
// (drag/drop, multi-select) port cleanly.

import { memo, useMemo } from "react"
import { useTranslations } from "next-intl"
import { ShieldCheckIcon, AlertTriangleIcon, CircleAlertIcon } from "lucide-react"
import type { PluginRow } from "@/lib/db/plugin-types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { cn } from "@/lib/utils"
import { getAllContributions } from "@/lib/plugin/contracts/capability-contributions"
import { PluginRowActionsMenu } from "./plugin-row-actions-menu"
import { PluginSignatureBadge, type SignatureState } from "./plugin-signature-badge"
import { PluginActivationProgress } from "./plugin-activation-progress"
import { PluginRuntimeWarnings, PluginStatusPill } from "./plugin-status-badge"
import { PluginVersionBadge } from "./_shared/plugin-version-badge"
import { PluginAvatar } from "./plugin-avatar"

interface Props {
  plugin: PluginRow
  selected: boolean
  onToggleSelect: (id: string) => void
  onOpen: (id: string) => void
  onConfigure: (id: string) => void
  onToggleEnabled: (plugin: PluginRow) => void
  onUninstall: (plugin: PluginRow) => void
  onReviewPermissions: (id: string) => void
  onRollback?: (id: string) => void
}

// Memoized for the same reason as PluginLibraryRow: grid re-renders track
// store changes, while row objects stay identity-stable across re-filters.
export const PluginCard = memo(function PluginCard({
  plugin,
  selected,
  onToggleSelect,
  onOpen,
  onConfigure,
  onToggleEnabled,
  onUninstall,
  onReviewPermissions,
  onRollback,
}: Props) {
  const t = useTranslations("plugins.card")
  const status = plugin.status
  const errored = status === "error"
  const isLoading = status === "loading" || status === "enabling" || status === "updating"
  const permissionCount = (plugin.manifest as { permissions?: string[] })?.permissions?.length ?? 0
  const dangerousPermissions = (
    (plugin.manifest as { permissions?: string[] })?.permissions ?? []
  ).filter(
    (p) =>
      p === "shell:execute" ||
      p === "process:spawn" ||
      p === "python:execute" ||
      p === "filesystem:write"
  )
  const signatureState: SignatureState = (() => {
    const sig = (plugin.manifest as { signature?: { verified?: boolean; failed?: boolean } })
      ?.signature
    if (sig?.verified) return "verified"
    if (sig?.failed) return "failed"
    return "unverified"
  })()
  const updateAvailable = !!(plugin.manifest as { updateAvailable?: boolean })?.updateAvailable
  const contributions = useMemo(
    () => getAllContributions(plugin.capabilities, plugin.manifest),
    [plugin.capabilities, plugin.manifest]
  )

  return (
    <Card
      className={cn(
        // `h-full` keeps every card in the responsive grid the same height,
        // so action menus and metadata footers line up at the bottom even
        // when descriptions vary in length.
        "group relative flex h-full flex-col gap-2 p-3 transition-colors hover:border-primary/40",
        selected && "border-primary",
        !plugin.enabled && "opacity-70",
        errored && "border-destructive bg-destructive/5"
      )}
      data-plugin-id={plugin.id}
      data-errored={errored || undefined}
    >
      <div className="flex items-start gap-2">
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggleSelect(plugin.id)}
          className="mt-0.5"
          aria-label={t("selectAria", { name: plugin.name })}
        />
        <PluginAvatar
          name={plugin.name}
          icon={(plugin.manifest as { icon?: string })?.icon}
          seed={plugin.id}
          size={28}
          className="mt-0.5"
        />
        <Button
          variant="ghost"
          className="flex-1 min-w-0 h-auto justify-start p-0 text-left font-normal hover:bg-transparent"
          onClick={() => onOpen(plugin.id)}
        >
          <div className="block w-full min-w-0">
            {/* flex-wrap lets the version / "update available" badges drop to
             *  a second line in narrow grid columns instead of overflowing
             *  the card; the name still truncates on its own line. */}
            <div className="flex flex-wrap items-center gap-1.5 min-w-0">
              <span className="font-medium truncate">{plugin.name}</span>
              <PluginVersionBadge version={plugin.version} className="shrink-0" />
              {updateAvailable && (
                <Badge variant="secondary" className="text-xs shrink-0">
                  {t("updateBadge")}
                </Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground truncate mt-0.5">{plugin.id}</div>
          </div>
        </Button>

        <PluginRowActionsMenu
          plugin={plugin}
          onOpen={onOpen}
          onConfigure={onConfigure}
          onReviewPermissions={onReviewPermissions}
          onToggleEnabled={onToggleEnabled}
          onUninstall={onUninstall}
          onRollback={onRollback}
        />
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {/* Unified 3-chip cap matches the marketplace card so the same
         *  plugin renders consistently across "browse" and "installed"
         *  surfaces. The richer per-contribution hover preview lives in
         *  the bespoke CardCapabilityChip below — _shared/capability-chips
         *  doesn't carry the count + entries axis. */}
        {contributions.slice(0, 3).map((contribution) => (
          <CardCapabilityChip
            key={contribution.capability}
            capability={String(contribution.capability)}
            count={contribution.count}
            entries={contribution.entries}
          />
        ))}
        {contributions.length > 3 && (
          <Badge variant="outline" className="text-xs">
            +{contributions.length - 3}
          </Badge>
        )}
      </div>

      {/* flex-wrap + min-w-0 keep the source / signature / permission group and
       *  the status pill from overflowing the card in narrow grid columns —
       *  the pill drops below the metadata instead of spilling past the edge. */}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge variant="outline" className="text-xs">
            {plugin.source}
          </Badge>
          <PluginSignatureBadge state={signatureState} compact />
          {permissionCount > 0 && (
            <span className="flex items-center gap-1 whitespace-nowrap">
              <ShieldCheckIcon className="size-3 shrink-0" />
              {t("permissionCount", { count: permissionCount })}
              {dangerousPermissions.length > 0 && (
                <AlertTriangleIcon className="size-3 shrink-0 text-destructive" />
              )}
            </span>
          )}
        </div>
        <PluginStatusPill status={status} enabled={plugin.enabled} loading={isLoading} />
        <PluginActivationProgress pluginId={plugin.id} pluginName={plugin.name} variant="card" />
      </div>

      <PluginRuntimeWarnings plugin={plugin} />

      {errored && plugin.error && (
        <div className="flex items-start gap-1 text-xs text-destructive">
          <CircleAlertIcon className="size-3 mt-0.5 shrink-0" />
          <span className="line-clamp-2">{plugin.error}</span>
        </div>
      )}
    </Card>
  )
})

interface CardCapabilityChipProps {
  capability: string
  count: number
  entries: ReadonlyArray<{ id: string; label?: string }>
}

// Mirror of PluginLibraryRow's capability chip — same surface so the two
// views stay consistent. Plain chip when no contribution surface is mapped,
// hover-card with id list otherwise.
function CardCapabilityChip({ capability, count, entries }: CardCapabilityChipProps) {
  const t = useTranslations("plugins.card")
  const label = count > 0 ? `${capability} · ${count}` : capability
  if (entries.length === 0) {
    return (
      <Badge variant="outline" className="text-xs">
        {label}
      </Badge>
    )
  }
  return (
    <HoverCard openDelay={150}>
      <HoverCardTrigger asChild>
        <Badge
          variant="outline"
          className="text-xs cursor-help"
          tabIndex={0}
          aria-label={t("capabilityChipAria", { capability, count })}
        >
          {label}
        </Badge>
      </HoverCardTrigger>
      <HoverCardContent className="w-72 p-3" align="start">
        <div className="space-y-2">
          <div className="text-xs font-semibold">{label}</div>
          <ul className="space-y-0.5 text-xs">
            {entries.map((entry) => (
              <li key={entry.id} className="flex items-baseline gap-1.5">
                <code className="font-mono text-[10px] text-muted-foreground">{entry.id}</code>
                {entry.label && entry.label !== entry.id && (
                  <span className="text-muted-foreground">— {entry.label}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}
