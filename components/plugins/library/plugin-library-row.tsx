"use client"

// Compact one-row-per-plugin renderer used by the Library list view.
// Mirrors the affordances of PluginCard (selection checkbox + click-to-
// detail + status pill + capability chips + actions menu) but packs the
// content into a single horizontal row so users can browse 50+ plugins
// without scrolling forever. Action set is shared with PluginCard via
// PluginRowActionsMenu so the two views can't drift.
//
// Two structural rules this file exists to hold:
//
//   1. **No nested interactive elements.** The row used to wrap the avatar,
//      title, capability chips (focusable HoverCard triggers) and the
//      activation-progress control in ONE <button>. Putting focusable
//      descendants inside a button is invalid and leaves the chips
//      unreachable by keyboard. The open affordance is now a button around
//      the *name only*, stretched over the row by an `after:`
//      pseudo-element. Every sibling that needs its own pointer or focus
//      target sits above that overlay with `relative z-10`.
//
//   2. **Capability chips live on the second line and are gated at
//      `@sm/plugin-list`.** They used to share line one behind
//      `@2xl/plugin-list` (672px). The library list is a fraction of the
//      window, so at the default split that gate never opened and the row
//      degraded to name / version / status on an ordinary desktop. Line two
//      has the whole row width, so 384px is enough for three chips.

import { memo, useMemo } from "react"
import { useTranslations } from "next-intl"
import { CircleAlertIcon, ShieldCheckIcon, TriangleAlertIcon } from "lucide-react"
import type { PluginRow } from "@/lib/db/plugin-types"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { cn } from "@/lib/utils"
import { getAllContributions } from "@/lib/plugin/contracts/capability-contributions"
import { PluginCompatibilityBadge } from "../_shared/plugin-compatibility-badge"
import { PluginRowActionsMenu } from "../plugin-row-actions-menu"
import { PluginSignatureBadge, type SignatureState } from "../plugin-signature-badge"
import { PluginSourceBadge, isDevelopmentSource, parsePluginSource } from "../plugin-source-badge"
import { PluginActivationProgress } from "../plugin-activation-progress"
import { PluginRuntimeWarnings, PluginStatusPill } from "../plugin-status-badge"
import { PluginVersionBadge } from "../_shared/plugin-version-badge"
import { PluginAvatar } from "../plugin-avatar"

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

/** `manifest.author` is `string | { name }` depending on how old the manifest is. */
function readAuthor(manifest: PluginRow["manifest"]): string | undefined {
  const author = (manifest as { author?: string | { name?: string } })?.author
  if (typeof author === "string") return author.trim() || undefined
  return author?.name?.trim() || undefined
}

// Memoized: the list re-renders on every store change (search keystrokes,
// selection, detail focus) while row objects keep their identity across
// re-filters, so memo limits the work to rows whose own props changed.
export const PluginLibraryRow = memo(function PluginLibraryRow({
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
  const parsedSource = parsePluginSource(plugin.source)
  const developmentSource = parsedSource !== null && isDevelopmentSource(parsedSource)
  const permissionCount = (plugin.manifest as { permissions?: string[] })?.permissions?.length ?? 0
  const author = readAuthor(plugin.manifest)
  const contributions = useMemo(
    () => getAllContributions(plugin.capabilities, plugin.manifest),
    [plugin.capabilities, plugin.manifest]
  )

  return (
    <div
      className={cn(
        // `min-w-0` + `overflow-hidden`: the row is a flex child of a column
        // that must never grow past the pane. Without both, a plugin with long
        // capability chips widened every row, and the list's scroll container
        // answered with a horizontal scrollbar that shifted the WHOLE list
        // sideways, names and all.
        "group relative flex min-w-0 items-center gap-2 overflow-hidden border-b px-2 py-1.5 text-sm",
        "transition-colors hover:bg-accent/40",
        // Active = selected detail target, so render a 3px primary accent bar
        // via a pseudo-element. It composes with the errored left border
        // without one overwriting the other.
        active &&
          "bg-accent/60 before:absolute before:inset-y-0 before:left-0 before:z-10 before:w-[3px] before:bg-primary",
        !plugin.enabled && "opacity-70",
        // Errored gets a destructive tint + thicker left border so the row
        // is unmistakably distinct from disabled/loading.
        errored && "border-l-2 border-l-destructive bg-destructive/5"
      )}
      data-plugin-id={plugin.id}
      data-active={active}
      data-errored={errored || undefined}
    >
      <Checkbox
        checked={selected}
        onCheckedChange={() => onToggleSelect(plugin.id)}
        aria-label={t("selectAria", { name: plugin.name })}
        className="relative z-10 shrink-0"
      />
      <PluginAvatar
        name={plugin.name}
        icon={(plugin.manifest as { icon?: string })?.icon}
        pluginRoot={plugin.path}
        seed={plugin.id}
        size={24}
        className="shrink-0"
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          {/* The open affordance. `after:inset-0` stretches its hit area over
              the whole row without swallowing the siblings, which keep their
              own stacking context via `relative z-10`. */}
          <button
            type="button"
            onClick={() => onOpen(plugin.id)}
            className="min-w-0 truncate text-left font-medium after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
            data-testid={`plugin-library-row-${plugin.id}`}
          >
            {plugin.name}
          </button>
          <PluginVersionBadge version={plugin.version} className="shrink-0" />
          {/*
            Only development origins are badged here. Every row saying
            "Marketplace" is noise, but a dev or local build sitting in the
            list unmarked is how an author ends up debugging the wrong copy.
          */}
          {developmentSource && <PluginSourceBadge source={plugin.source} className="shrink-0" />}
          {updateAvailable && (
            <Badge variant="secondary" className="shrink-0 text-xs">
              {t("updateBadge")}
            </Badge>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {permissionCount > 0 && (
              <span className="hidden items-center gap-1 text-xs text-muted-foreground @md/plugin-list:flex">
                <ShieldCheckIcon className="size-3" />
                {permissionCount}
              </span>
            )}
            {/* Icon-only until the list has room: the words are long, they
                repeat on every row on a browser build, and the tooltip says
                the same thing. */}
            <PluginCompatibilityBadge
              manifest={plugin.manifest}
              labelClassName="hidden @xl/plugin-list:inline"
            />
            <PluginSignatureBadge state={signatureState} compact />
            {errored && (
              <TriangleAlertIcon
                className="size-3.5 shrink-0 text-destructive"
                aria-label={t("erroredAria")}
              />
            )}
            <PluginStatusPill status={plugin.status} enabled={plugin.enabled} loading={isLoading} />
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
          {author && <span className="max-w-[40%] shrink-0 truncate">{author}</span>}
          {author && contributions.length > 0 && (
            <span aria-hidden className="shrink-0">
              ·
            </span>
          )}
          {/*
            The chips scroll INSIDE their own strip.

            They are fixed-width pills that cannot truncate, so in a narrow
            pane they used to run off the end of the row and force the list's
            scroll container into a horizontal scrollbar. Clipping them instead
            would hide capabilities with no way to reach them. A local
            overflow-x keeps the row at the pane's width and still lets the
            chips be read, and the scrollbar itself is hidden because a visible
            one on every row is louder than the content.
          */}
          <div
            className="relative z-10 hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] @sm/plugin-list:flex [&::-webkit-scrollbar]:hidden"
            data-testid="plugin-library-row-capabilities"
          >
            {contributions.slice(0, 3).map((contribution) => (
              <CapabilityHoverChip
                key={contribution.capability}
                capability={String(contribution.capability)}
                count={contribution.count}
                entries={contribution.entries}
              />
            ))}
            {contributions.length > 3 && (
              <Badge
                variant="outline"
                className="shrink-0 text-xs"
                aria-label={t("moreCapabilitiesAria", { count: contributions.length - 3 })}
              >
                +{contributions.length - 3}
              </Badge>
            )}
          </div>
          {/* The loader stamps these when it hands back a stub instead of a
              runtime. Only the card grid rendered them, so in the default list
              view a plugin could read "Enabled" while doing nothing at all. */}
          <PluginRuntimeWarnings plugin={plugin} className="relative z-10 shrink-0" />
          {errored && plugin.error && (
            <span className="flex min-w-0 items-center gap-0.5 text-destructive">
              <CircleAlertIcon className="size-3 shrink-0" />
              <span className="line-clamp-1">{plugin.error}</span>
            </span>
          )}
        </div>
      </div>
      {/* Pinned to the row's bottom edge rather than sitting in the status
          cluster. An activation bar that joins the inline flow shifts every
          badge beside it the moment it appears and shifts them back when the
          activation ends, and a cold start activates plugins one after another
          — which is the row-level half of the "the list jitters while it
          loads" report. Out of flow, the bar can come and go without moving
          anything. */}
      <PluginActivationProgress
        pluginId={plugin.id}
        pluginName={plugin.name}
        variant="row"
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 mt-0"
      />
      <PluginRowActionsMenu
        plugin={plugin}
        onOpen={onOpen}
        onConfigure={onConfigure}
        onToggleEnabled={onToggleEnabled}
        onUninstall={onUninstall}
        onReviewPermissions={onReviewPermissions}
        onRollback={onRollback}
        triggerClassName="relative z-10 size-6 shrink-0"
      />
    </div>
  )
})

interface CapabilityHoverChipProps {
  capability: string
  count: number
  entries: ReadonlyArray<{ id: string; label?: string }>
}

// Capability badge that, when hovered or focused, surfaces the concrete
// contributions for that capability (e.g. capability="tools" gives the ids of
// every declared tool). Falls back to a plain badge when the manifest exposes
// no contribution surface for the tag (entries.length === 0).
function CapabilityHoverChip({ capability, count, entries }: CapabilityHoverChipProps) {
  const t = useTranslations("plugins.card")
  const label = count > 0 ? `${capability} · ${count}` : capability
  if (entries.length === 0) {
    return (
      <Badge variant="outline" className="shrink-0 text-xs">
        {label}
      </Badge>
    )
  }
  return (
    <HoverCard openDelay={150}>
      <HoverCardTrigger asChild>
        <Badge
          variant="outline"
          className="shrink-0 cursor-help text-xs"
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
                  <span className="text-muted-foreground">{entry.label}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}
