"use client"

// Detail-pane header: who the plugin is, what state it is in, and what can be
// done to it. Three bands, top to bottom:
//
//   1. Identity: avatar, name, version, description, and (inline pane only) a
//      close button. The phone drawer and the tablet sheet bring their own.
//   2. Status: one wrapping line of small badges (runtime status, lifecycle,
//      source, compatibility, signature, runtime warnings), then the latest
//      diagnostics as ONE summary line that expands on demand.
//   3. Actions: a LABELLED enable switch ("Enabled" / "Disabled", because a
//      bare switch on a phone says nothing about which side is on), an Update
//      button when the marketplace has a newer version, Retry cleanup when the
//      runtime is dirty, and the shared actions menu.
//
// The actions menu is `PluginRowActionsMenu` in its detail context, so the
// row and the header cannot drift on Configure / Review permissions /
// Rollback / Always-on / Uninstall, their gates, or their wording. Every item
// in a menu carries its label on every screen size, which the old icon-only
// header buttons never did on a phone (their labels were gated on a 512px
// header the phone drawer never reaches). The detail-only items (open logs,
// view raw manifest) ride in through `extraItems`.
//
// The Switch consults `usePluginEnableGate`: a plugin this host cannot run is
// not offered an Enable it could only fail, and the reason is printed under
// the header instead of hiding in a tooltip. On a mirrored phone the plugin is
// judged against the desktop that runs it, and the header says so.
//
// Diagnostics used to be an always-open amber box in this header. The header
// does not scroll, so on a phone the box and the identity rows took half the
// drawer before a single tab was visible. A summary line keeps the signal (the
// count and its severity colour) and gives the space back.

import { useId, useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import {
  AlertCircleIcon,
  ArrowUpCircleIcon,
  ChevronRightIcon,
  CodeIcon,
  MonitorIcon,
  RotateCcwIcon,
  ScrollTextIcon,
  XIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { getPluginManager } from "@/lib/plugin/core/manager"
import { buildPluginLogsHref } from "@/lib/plugin/devtools/plugin-logs-link"
import { isPluginType, logSourcesFor } from "@/lib/plugin/devtools/runtime-log-stream"
import { usePluginDiagnostics } from "@/hooks/plugins"
import { useLocalizedPluginText } from "@/hooks/plugins/use-localized-plugin-text"
import { usePluginEnableAction } from "@/hooks/plugins/use-plugin-enable-action"
import { usePluginEnableGate } from "@/hooks/plugins/use-plugin-enable-gate"
import { usePluginsStore } from "@/stores/plugins"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import type { PluginRow } from "@/lib/db/plugin-types"
import { PluginCompatibilityBadge } from "../_shared/plugin-compatibility-badge"
import { PluginSourceBadge } from "../plugin-source-badge"
import { PluginSignatureBadge, type SignatureState } from "../plugin-signature-badge"
import { PluginActivationProgress } from "../plugin-activation-progress"
import { PluginRuntimeWarnings, PluginStatusPill } from "../plugin-status-badge"
import { PluginAvatar } from "../plugin-avatar"
import { PluginHint } from "../_shared/plugin-hint"
import { MenuItemLabel, PluginRowActionsMenu } from "../plugin-row-actions-menu"

interface Props {
  plugin: PluginRow
  /**
   * Renders a close button in the identity row. Passed by the inline desktop
   * pane only: the tablet sheet and the phone drawer already carry their own
   * dismiss control, and two close buttons on one surface is one too many.
   */
  onClose?: () => void
  /**
   * The host draws its own close button in the top-right corner (the tablet
   * Sheet); keep that corner clear rather than letting it cover the name.
   */
  reserveCloseCorner?: boolean
}

export function PluginDetailHeader({ plugin, onClose, reserveCloseCorner }: Props) {
  const t = useTranslations("plugins.detail")
  const tLifecycle = useTranslations("plugins.lifecycleFeedback")
  const gate = usePluginEnableGate(plugin)
  const enablePlugin = usePluginEnableAction()
  // Turning OFF an incompatible plugin stays possible: it is always safe and
  // is how a user clears a stale "enabled" left from another host.
  const enableBlocked = !plugin.enabled && gate.blocked
  const openConfigure = usePluginsStore((s) => s.openConfigure)
  const openPermissionReview = usePluginsStore((s) => s.openPermissionReview)
  const setDeleteTarget = usePluginsStore((s) => s.setDeleteTarget)
  const setRollbackTarget = usePluginsStore((s) => s.setRollbackTarget)
  const openUpdateDialog = usePluginsStore((s) => s.openUpdateDialog)
  const openDetailManifest = usePluginsStore((s) => s.openDetailManifest)
  const diagnostics = usePluginDiagnostics(plugin.id)
  // `PluginRow` is the Dexie projection and carries no descriptor, so the
  // shadowing check reads the live runtime record instead.
  const observedSources = usePluginStore(
    (state) => state.plugins[plugin.id]?.descriptor?.identity.observedSources
  )
  const [recovering, setRecovering] = useState(false)
  const [recoveryFailed, setRecoveryFailed] = useState(false)
  const switchId = useId()

  const signatureState: SignatureState = (() => {
    const sig = (plugin.manifest as { signature?: { verified?: boolean; failed?: boolean } })
      ?.signature
    if (sig?.verified) return "verified"
    if (sig?.failed) return "failed"
    return "unverified"
  })()
  const isLoading =
    plugin.status === "loading" || plugin.status === "enabling" || plugin.status === "updating"
  const updateAvailable = !!(plugin.manifest as { updateAvailable?: boolean })?.updateAvailable
  // Name and description in the user's language (manifest nameKey / descriptionKey).
  const { name: displayName, description } = useLocalizedPluginText(plugin)
  const lifecycleActual = plugin.lifecycle?.actual
  // Logs belong to the log panel. A runtime whose host serves no log channel
  // (wasm) still gets the menu item, disabled, with the reason in it: an item
  // that silently disappears for some plugins reads as a missing feature.
  const logSources = isPluginType(plugin.type) ? logSourcesFor(plugin.type) : null
  const hasLogChannel = !!logSources && logSources.runtimes.length > 0

  const recoverRuntime = async () => {
    setRecovering(true)
    setRecoveryFailed(false)
    try {
      const recovered = await getPluginManager().recoverPluginRuntime(plugin.id)
      setRecoveryFailed(!recovered)
    } catch {
      setRecoveryFailed(true)
    } finally {
      setRecovering(false)
    }
  }

  return (
    <header
      className={cn(
        "@container/plugin-detail-header relative shrink-0 space-y-2 border-b px-3 pt-3 pb-2",
        reserveCloseCorner && "pr-11"
      )}
      data-testid="plugin-detail-header"
    >
      {/* 1. Identity */}
      <div className="flex items-start gap-2.5">
        <PluginAvatar
          name={plugin.name}
          icon={(plugin.manifest as { icon?: string })?.icon}
          pluginRoot={plugin.path}
          seed={plugin.id}
          size={32}
          className="shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <h2 className="min-w-0 truncate text-base leading-tight font-semibold">
              {displayName}
            </h2>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              {t("versionLabel", { version: plugin.version })}
            </span>
          </div>
          {description ? (
            // Two lines in a narrow pane, three once there is room. The
            // description is context, not the reason the pane is open, so it
            // must not push the actions and the tab bar below the fold.
            <p
              className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground @lg/plugin-detail-header:line-clamp-3"
              title={description}
            >
              {description}
            </p>
          ) : null}
        </div>
        {onClose ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="-mt-1 -mr-1 size-7 shrink-0 pointer-coarse:size-10"
            onClick={onClose}
            aria-label={t("closeAria", { name: displayName })}
            data-testid="plugin-detail-close"
          >
            <XIcon className="size-4" />
          </Button>
        ) : null}
      </div>

      {/* 2. Status */}
      <div className="flex flex-wrap items-center gap-1" data-testid="plugin-detail-status">
        <PluginStatusPill
          status={plugin.status}
          enabled={plugin.enabled}
          loading={isLoading}
          lifecycle={plugin.lifecycle}
        />
        {lifecycleActual && lifecycleActual !== "active" && lifecycleActual !== "inactive" && (
          <Badge variant={lifecycleActual === "dirty" ? "destructive" : "secondary"}>
            {t(`lifecycle.${lifecycleActual}`)}
          </Badge>
        )}
        {/* Localized, and a dev build reads differently from a released one. */}
        <PluginSourceBadge source={plugin.source} observedSources={observedSources} />
        <PluginCompatibilityBadge manifest={plugin.manifest} />
        {gate.runsOnDesktop ? (
          <PluginHint
            label={tLifecycle("runsOnDesktop")}
            content={<p>{tLifecycle("runsOnDesktopHint")}</p>}
            testId="plugin-detail-runs-on-desktop"
          >
            <Badge variant="outline" className="gap-1 text-xs">
              <MonitorIcon className="size-3" aria-hidden />
              {tLifecycle("runsOnDesktop")}
            </Badge>
          </PluginHint>
        ) : null}
        <PluginSignatureBadge state={signatureState} compact />
        <PluginRuntimeWarnings plugin={plugin} />
      </div>

      {diagnostics.length > 0 && <DiagnosticsSummary entries={diagnostics} />}

      {/* Inline, not a tooltip: a disabled Switch cannot be hovered on a
          phone, and the reason is the whole point of disabling it. */}
      {enableBlocked && gate.reason ? (
        <div
          id={`plugin-enable-blocked-${plugin.id}`}
          className="space-y-0.5 text-xs text-muted-foreground"
          data-testid="plugin-detail-enable-blocked"
        >
          <p>{gate.reason}</p>
          {gate.authorReason ? <p className="break-words">{gate.authorReason}</p> : null}
        </div>
      ) : null}

      {/* 3. Actions */}
      <div className="flex items-center gap-2" data-testid="plugin-detail-actions">
        {/* The label is the hit area, so the whole "switch + word" target is
            40px tall on a coarse pointer while the switch itself keeps its
            drawn size. */}
        <label
          htmlFor={switchId}
          className={cn(
            "flex min-w-0 cursor-pointer items-center gap-2 rounded-md py-1 pr-2 text-sm pointer-coarse:min-h-10",
            enableBlocked && "cursor-not-allowed"
          )}
        >
          <Switch
            id={switchId}
            checked={plugin.enabled}
            disabled={enableBlocked}
            onCheckedChange={(next) => void enablePlugin(plugin, next)}
            aria-describedby={enableBlocked ? `plugin-enable-blocked-${plugin.id}` : undefined}
            data-testid="plugin-detail-enable-toggle"
          />
          <span
            className={cn("truncate", plugin.enabled ? "font-medium" : "text-muted-foreground")}
          >
            {plugin.enabled ? t("enabledLabel") : t("disabledLabel")}
          </span>
        </label>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {lifecycleActual === "dirty" && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1 px-2 text-xs pointer-coarse:h-10"
              disabled={recovering}
              onClick={() => void recoverRuntime()}
              data-testid="plugin-detail-retry-cleanup"
            >
              <RotateCcwIcon className={cn("size-3.5", recovering && "animate-spin")} />
              {recovering ? t("lifecycle.retrying") : t("lifecycle.retryCleanup")}
            </Button>
          )}
          {updateAvailable && (
            <Button
              type="button"
              size="sm"
              className="h-7 gap-1 px-2 text-xs pointer-coarse:h-10"
              onClick={() => openUpdateDialog(plugin.id)}
              data-testid="plugin-detail-update"
            >
              <ArrowUpCircleIcon className="size-3.5" />
              {t("update")}
            </Button>
          )}
          <PluginRowActionsMenu
            plugin={plugin}
            context="detail"
            onOpen={() => undefined}
            onConfigure={openConfigure}
            onReviewPermissions={openPermissionReview}
            onToggleEnabled={(row) => void enablePlugin(row, !row.enabled)}
            onUninstall={(row) => setDeleteTarget({ pluginId: row.id, name: displayName })}
            onRollback={setRollbackTarget}
            triggerClassName="size-7 shrink-0 pointer-coarse:size-10"
            extraItems={
              <>
                {hasLogChannel ? (
                  <DropdownMenuItem asChild>
                    <Link
                      href={buildPluginLogsHref({ pluginId: plugin.id })}
                      data-testid="plugin-detail-open-logs"
                    >
                      <ScrollTextIcon className="mr-2 size-3.5" />
                      {t("logs.openInPanelShort")}
                    </Link>
                  </DropdownMenuItem>
                ) : logSources?.missingReason ? (
                  <DropdownMenuItem
                    disabled
                    className="items-start"
                    data-testid="plugin-detail-open-logs"
                  >
                    <ScrollTextIcon className="mt-0.5 mr-2 size-3.5 shrink-0" />
                    <MenuItemLabel
                      label={t("logs.openInPanelShort")}
                      detail={t(`logs.missing.${logSources.missingReason}` as never)}
                    />
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  onClick={openDetailManifest}
                  data-testid="plugin-detail-view-manifest"
                >
                  <CodeIcon className="mr-2 size-3.5" />
                  {t("rawManifest")}
                </DropdownMenuItem>
              </>
            }
          />
        </div>
      </div>

      {/* Pinned to the header's bottom border, out of flow. In flow, the bar
          (and its phase line) pushed the badges and the whole pane body down
          the moment an activation started and pulled them back up when it
          ended. The status pill already says "Loading", and the bar's live
          region still announces the phase and count. */}
      <PluginActivationProgress
        pluginId={plugin.id}
        pluginName={displayName}
        variant="row"
        className="pointer-events-none absolute inset-x-0 bottom-0 mt-0"
      />

      {recoveryFailed && (
        <p className="text-xs text-destructive" role="status">
          {t("lifecycle.retryFailed")}
        </p>
      )}
    </header>
  )
}

interface DiagnosticEntry {
  code: string
  severity: "warning" | "error"
  message: string
  hint?: string
  pointKind?: string
  pointId?: string
}

/**
 * One summary line ("2 diagnostic entries · 1 error"), expandable to the full
 * list, newest first. The list renders as rows behind a left severity rule,
 * not as a tinted box: it sits inside the header, which already is a band.
 */
function DiagnosticsSummary({ entries }: { entries: ReadonlyArray<DiagnosticEntry> }) {
  const t = useTranslations("plugins.detail")
  const [expanded, setExpanded] = useState(false)
  const listId = useId()
  const latest = [...entries].reverse()
  const errorCount = entries.filter((e) => e.severity === "error").length

  return (
    <div
      role="region"
      aria-label={t("diagnostics.ariaLabel")}
      data-testid="plugin-detail-diagnostics-preview"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={listId}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 text-left text-xs hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-h-10"
        data-testid="plugin-detail-diagnostics-toggle"
      >
        <AlertCircleIcon
          className={cn(
            "size-3.5 shrink-0",
            errorCount > 0 ? "text-destructive" : "text-amber-600"
          )}
          aria-hidden
        />
        <span className="min-w-0 truncate font-medium">
          {t("diagnostics.title", { count: entries.length })}
        </span>
        {!expanded ? (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {latest[0]?.message}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90"
          )}
          aria-hidden
        />
      </button>
      {expanded ? (
        <ul id={listId} className="mt-1.5 space-y-1.5 text-xs">
          {latest.map((entry, idx) => (
            <li
              key={`${entry.code}-${idx}`}
              className={cn(
                "border-l-2 pl-2",
                entry.severity === "error" ? "border-destructive" : "border-amber-500"
              )}
            >
              <div className="font-medium break-words">{entry.message}</div>
              {entry.hint && <div className="text-[11px] text-muted-foreground">{entry.hint}</div>}
              {(entry.pointKind || entry.pointId) && (
                <code className="text-[10px] text-muted-foreground">
                  {[entry.pointKind, entry.pointId].filter(Boolean).join(":")}
                </code>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
