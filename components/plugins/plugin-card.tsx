"use client"

// The Library's card view (`PluginPanelGrid`, reached from the list's
// view toggle). Surfaces version, capability chips, permission count, status,
// source, signature status, and an action menu (open / configure /
// enable-disable / uninstall). Mirrors the shape of
// `components/skills/skill-card.tsx` so future shared treatments (drag/drop,
// multi-select) port cleanly.
//
// The whole card opens the detail pane, the same way a Library row does: the
// name is the one real <button>, and its `after:inset-0` pseudo-element
// stretches the hit area over the card. Everything else that is interactive
// (checkbox, actions menu, chips, badges with hints) sits above it with
// `relative z-10`. The card used to wrap the name AND its badges in one
// <button> full of block <div>s, which is invalid HTML (a button may hold only
// phrasing content) and made the badges part of the button's accessible name.

import { memo, useMemo } from "react"
import { useTranslations } from "next-intl"
import { useLocalizedPluginText } from "@/hooks/plugins/use-localized-plugin-text"
import { ShieldCheckIcon, AlertTriangleIcon, CircleAlertIcon } from "lucide-react"
import type { PluginRow } from "@/lib/db/plugin-types"
import { isPluginRowErrored } from "@/hooks/plugins/use-plugins"
import { DANGEROUS_PERMISSIONS } from "@/lib/plugin/security/permission-guard"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"
import { getAllContributions } from "@/lib/plugin/contracts/capability-contributions"
import { PluginRowActionsMenu } from "./plugin-row-actions-menu"
import { PluginSignatureBadge, type SignatureState } from "./plugin-signature-badge"
import { PluginSimulatedBadge } from "./_shared/plugin-simulated-badge"
import { PluginActivationProgress } from "./plugin-activation-progress"
import { PluginCompatibilityBadge } from "./_shared/plugin-compatibility-badge"
import { PluginRuntimeWarnings, PluginStatusPill } from "./plugin-status-badge"
import { PluginVersionBadge } from "./_shared/plugin-version-badge"
import { PluginAvatar } from "./plugin-avatar"
import { PluginContributionChip } from "./_shared/plugin-contribution-chip"
import { PluginSourceBadge } from "./plugin-source-badge"

const DANGEROUS = new Set<string>(DANGEROUS_PERMISSIONS)

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
  const { name: displayName } = useLocalizedPluginText(plugin)
  const status = plugin.status
  // The same predicate the "Errored" quick filter and its count use, so a
  // card the filter shows as errored also looks errored.
  const errored = isPluginRowErrored(plugin)
  const errorMessage = plugin.error ?? plugin.lifecycle?.lastError
  const isLoading = status === "loading" || status === "enabling" || status === "updating"
  const permissions = (plugin.manifest as { permissions?: string[] })?.permissions ?? []
  const permissionCount = permissions.length
  // The guard's canonical list, not a hand-picked four: network egress, chat
  // interception, secrets writes and the rest are just as sensitive.
  const dangerousPermissions = permissions.filter((p) => DANGEROUS.has(p))
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
        {/* Padded label = a 40px hit area on a coarse pointer without
            changing the card's painted layout. */}
        <label className="relative z-10 -m-1.5 flex shrink-0 cursor-pointer p-1.5 pointer-coarse:-m-3 pointer-coarse:p-3">
          <Checkbox
            checked={selected}
            onCheckedChange={() => onToggleSelect(plugin.id)}
            className="mt-0.5"
            aria-label={t("selectAria", { name: displayName })}
          />
        </label>
        <PluginAvatar
          name={plugin.name}
          icon={(plugin.manifest as { icon?: string })?.icon}
          pluginRoot={plugin.path}
          seed={plugin.id}
          size={28}
          className="mt-0.5"
        />
        <div className="min-w-0 flex-1">
          {/* flex-wrap lets the version / "update available" badges drop to
           *  a second line in narrow grid columns instead of overflowing the
           *  card; the name still truncates on its own line. */}
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => onOpen(plugin.id)}
              className="min-w-0 truncate rounded-sm text-left font-medium after:absolute after:inset-0 after:rounded-[inherit] after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
              data-testid={`plugin-card-open-${plugin.id}`}
            >
              {displayName}
            </button>
            <PluginVersionBadge version={plugin.version} className="shrink-0" />
            {updateAvailable && (
              <Badge variant="secondary" className="shrink-0 text-xs">
                {t("updateBadge")}
              </Badge>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{plugin.id}</div>
        </div>

        <div className="relative z-10 shrink-0">
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
      </div>

      <div className="relative z-10 flex flex-wrap items-center gap-1">
        {/* Unified 3-chip cap matches the marketplace card so the same
         *  plugin renders consistently across "browse" and "installed"
         *  surfaces. The per-contribution preview is the shared
         *  PluginContributionChip (the Library row renders the same one) —
         *  _shared/capability-chips doesn't carry the count + entries axis. */}
        {contributions.slice(0, 3).map((contribution) => (
          <PluginContributionChip
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
          {/* The source badge the row and detail header use: a label for
              every source, the development marker, the shadowing note. */}
          <PluginSourceBadge source={plugin.source} />
          <PluginSignatureBadge state={signatureState} compact className="relative z-10" />
          <PluginSimulatedBadge pluginId={plugin.id} />
          {permissionCount > 0 && (
            <span className="flex items-center gap-1 whitespace-nowrap">
              <ShieldCheckIcon className="size-3 shrink-0" />
              {t("permissionCount", { count: permissionCount })}
              {dangerousPermissions.length > 0 && (
                <AlertTriangleIcon
                  className="size-3 shrink-0 text-destructive"
                  role="img"
                  aria-label={t("dangerousPermissionsAria", {
                    count: dangerousPermissions.length,
                  })}
                />
              )}
            </span>
          )}
        </div>
        <PluginStatusPill
          // A lifecycle error never reaches `row.status`; say "Error" here
          // too, or the pill reads "Enabled" on a card tinted as failed.
          status={errored ? "error" : status}
          enabled={plugin.enabled}
          loading={isLoading}
          lifecycle={plugin.lifecycle}
        />
        <PluginActivationProgress pluginId={plugin.id} pluginName={displayName} variant="card" />
      </div>

      <PluginCompatibilityBadge manifest={plugin.manifest} className="relative z-10" />
      <PluginRuntimeWarnings plugin={plugin} className="relative z-10" />

      {errored && errorMessage && (
        <div className="flex items-start gap-1 text-xs text-destructive">
          <CircleAlertIcon className="mt-0.5 size-3 shrink-0" />
          <span className="line-clamp-2">{errorMessage}</span>
        </div>
      )}
    </Card>
  )
})
