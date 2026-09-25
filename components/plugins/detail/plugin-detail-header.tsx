"use client"

// Detail-pane header. Consolidates the plugin's identity (name + version +
// description) with status pill, signature, enable/disable toggle, and the
// primary actions that the row menu otherwise hides (Configure / Review
// permissions / Uninstall). Also surfaces the latest plugin-point
// diagnostic entries inline so failures aren't buried behind the Data tab.
//
// The Switch consults `usePluginEnableGate`: a plugin this host cannot run is
// not offered an Enable it could only fail, and the reason is printed under
// the header instead of hiding in a tooltip. On a mirrored phone the plugin is
// judged against the desktop that runs it, and the header says so.

import { useState, type ComponentType } from "react"
import { useTranslations } from "next-intl"
import { useLocalizedPluginText } from "@/hooks/plugins/use-localized-plugin-text"
import { toast } from "sonner"
import {
  AlertCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  MonitorIcon,
  SettingsIcon,
  ShieldCheckIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { getPluginManager } from "@/lib/plugin/core/manager"
import { usePluginDiagnostics } from "@/hooks/plugins"
import { usePluginEnableAction } from "@/hooks/plugins/use-plugin-enable-action"
import { usePluginEnableGate } from "@/hooks/plugins/use-plugin-enable-gate"
import { pluginUninstallBlockReason } from "@/hooks/plugins/use-plugin-uninstall"
import { usePluginsStore } from "@/stores/plugins"
import type { PluginRow } from "@/lib/db/plugin-types"
import { PluginCompatibilityBadge } from "../_shared/plugin-compatibility-badge"
import { PluginSourceBadge } from "../plugin-source-badge"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import { PluginSignatureBadge, type SignatureState } from "../plugin-signature-badge"
import { PluginActivationProgress } from "../plugin-activation-progress"
import { PluginRuntimeWarnings, PluginStatusPill } from "../plugin-status-badge"
import { PluginAvatar } from "../plugin-avatar"
import { PluginHint } from "../_shared/plugin-hint"

interface Props {
  plugin: PluginRow
}

export function PluginDetailHeader({ plugin }: Props) {
  const t = useTranslations("plugins.detail")
  const tCard = useTranslations("plugins.card")
  const tLifecycle = useTranslations("plugins.lifecycleFeedback")
  const gate = usePluginEnableGate(plugin)
  const enablePlugin = usePluginEnableAction()
  const uninstallBlocked = pluginUninstallBlockReason(plugin)
  // Turning OFF an incompatible plugin stays possible: it is always safe and
  // is how a user clears a stale "enabled" left from another host.
  const enableBlocked = !plugin.enabled && gate.blocked
  const openConfigure = usePluginsStore((s) => s.openConfigure)
  const openPermissionReview = usePluginsStore((s) => s.openPermissionReview)
  const setDeleteTarget = usePluginsStore((s) => s.setDeleteTarget)
  const diagnostics = usePluginDiagnostics(plugin.id)
  // `PluginRow` is the Dexie projection and carries no descriptor, so the
  // shadowing check reads the live runtime record instead.
  const observedSources = usePluginStore(
    (state) => state.plugins[plugin.id]?.descriptor?.identity.observedSources
  )
  const [recovering, setRecovering] = useState(false)
  const [recoveryFailed, setRecoveryFailed] = useState(false)

  const signatureState: SignatureState = (() => {
    const sig = (plugin.manifest as { signature?: { verified?: boolean; failed?: boolean } })
      ?.signature
    if (sig?.verified) return "verified"
    if (sig?.failed) return "failed"
    return "unverified"
  })()
  const isLoading =
    plugin.status === "loading" || plugin.status === "enabling" || plugin.status === "updating"
  const hasConfigSchema = !!(plugin.manifest as { configSchema?: unknown }).configSchema
  const declaredPermissions = (plugin.manifest as { permissions?: unknown[] }).permissions ?? []
  const hasPermissions = declaredPermissions.length > 0
  // Name and description in the user's language (manifest nameKey / descriptionKey).
  const { name: displayName, description } = useLocalizedPluginText(plugin)
  const lifecycleActual = plugin.lifecycle?.actual

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
      className="@container/plugin-detail-header relative shrink-0 space-y-1.5 border-b px-2.5 py-2"
      data-testid="plugin-detail-header"
    >
      <div className="flex items-start gap-2">
        <PluginAvatar
          name={plugin.name}
          icon={(plugin.manifest as { icon?: string })?.icon}
          pluginRoot={plugin.path}
          seed={plugin.id}
          size={24}
          className="mt-0.5 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <h2 className="min-w-0 truncate text-sm leading-tight font-semibold">{displayName}</h2>
            <span className="shrink-0 text-[11px] font-normal text-muted-foreground">
              v{plugin.version}
            </span>
          </div>
          {description ? (
            // One line in a narrow pane, two once there is room. The description
            // is context, not the reason the pane is open, so it must not push
            // the status and the actions below the fold on a 280px rail.
            <p className="mt-0.5 line-clamp-1 text-xs leading-snug text-muted-foreground @sm/plugin-detail-header:line-clamp-2">
              {description}
            </p>
          ) : null}
        </div>
        <Switch
          checked={plugin.enabled}
          disabled={enableBlocked}
          onCheckedChange={(next) => void enablePlugin(plugin, next)}
          aria-label={plugin.enabled ? tCard("disable") : tCard("enable")}
          aria-describedby={enableBlocked ? `plugin-enable-blocked-${plugin.id}` : undefined}
          data-testid="plugin-detail-enable-toggle"
          className="mt-0.5 shrink-0"
        />
      </div>

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

      {/*
        Badges and actions share ONE wrapping row.

        They used to be two rows, and the second one held a single right-aligned
        Uninstall button, so a whole line of a pane that is often 280px wide was
        spent on one destructive action nobody is looking for. Wrapping them
        together means each control takes only the space it needs and the row
        count follows the pane width instead of being fixed at two.
      */}
      <div className="flex flex-wrap items-center gap-1">
        <PluginStatusPill status={plugin.status} enabled={plugin.enabled} loading={isLoading} />
        {lifecycleActual && lifecycleActual !== "active" && lifecycleActual !== "inactive" && (
          <Badge variant={lifecycleActual === "dirty" ? "destructive" : "secondary"}>
            {t(`lifecycle.${lifecycleActual}`)}
          </Badge>
        )}
        <PluginSignatureBadge state={signatureState} compact />
        {/*
          This used to render `plugin.source` raw, so the header read
          "dev" / "marketplace" in English regardless of locale, and a dev
          build looked no different from a released one.
        */}
        <PluginSourceBadge source={plugin.source} observedSources={observedSources} />
        {/* Both of these were being produced and shown nowhere: the
            compatibility diagnostic had no reader at all, and the loader's
            degraded-runtime markers were rendered only by the card grid. */}
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
        <PluginRuntimeWarnings plugin={plugin} />

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {hasConfigSchema && (
            <HeaderAction
              icon={SettingsIcon}
              label={tCard("configure")}
              onClick={() => openConfigure(plugin.id)}
            />
          )}
          {hasPermissions && (
            <HeaderAction
              icon={ShieldCheckIcon}
              label={tCard("reviewPermissions")}
              onClick={() => openPermissionReview(plugin.id)}
            />
          )}
          {lifecycleActual === "dirty" && (
            <HeaderAction
              icon={RotateCcwIcon}
              iconClassName={recovering ? "animate-spin" : undefined}
              label={recovering ? t("lifecycle.retrying") : t("lifecycle.retryCleanup")}
              disabled={recovering}
              onClick={() => void recoverRuntime()}
            />
          )}
          <HeaderAction
            icon={Trash2Icon}
            label={tCard("uninstall")}
            destructive
            // Not `disabled`: a disabled button cannot be tapped to learn WHY.
            // It stays focusable, reads as unavailable, and answers with the
            // reason instead of the confirm dialog.
            unavailable={uninstallBlocked !== null}
            onClick={() => {
              if (uninstallBlocked) {
                toast.message(tLifecycle(`uninstallBlocked.${uninstallBlocked}`))
                return
              }
              setDeleteTarget({ pluginId: plugin.id, name: displayName })
            }}
          />
        </div>
      </div>

      {/* Pinned to the header's bottom border, out of flow. In flow, the bar
          (and its phase line) pushed the badges, the diagnostics and the whole
          pane body down the moment an activation started and pulled them back
          up when it ended. The status pill above already says "Loading", and
          the bar's live region still announces the phase and count. */}
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

      {diagnostics.length > 0 && <DiagnosticsPreview entries={diagnostics} t={t} />}
    </header>
  )
}

interface HeaderActionProps {
  icon: ComponentType<{ className?: string }>
  label: string
  onClick: () => void
  disabled?: boolean
  /** Reads as unavailable but stays focusable and tappable (to explain why). */
  unavailable?: boolean
  destructive?: boolean
  iconClassName?: string
}

/**
 * A header action that spends the space it has.
 *
 * Icon-only until the header is wide enough for words, with the label always
 * reachable through the tooltip and the accessible name. The labelled buttons
 * ("Review permissions", "Retry cleanup") are long enough that three of them
 * forced a wrap on any pane narrower than about 460px, which is the common
 * case for this rail.
 */
function HeaderAction({
  icon: Icon,
  label,
  onClick,
  disabled,
  unavailable,
  destructive,
  iconClassName,
}: HeaderActionProps) {
  return (
    // `title` + `aria-label` rather than a Radix Tooltip: this header is
    // mounted in the right pane, in the phone Sheet, and in unit tests, and a
    // Tooltip throws wherever no TooltipProvider happens to be above it. The
    // label is what matters, and both attributes carry it either way.
    <Button
      size="sm"
      variant="ghost"
      disabled={disabled}
      aria-disabled={unavailable || undefined}
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        // 36px on a coarse pointer: 24px icon buttons were a miss on a phone.
        "h-6 gap-1 px-1.5 text-xs pointer-coarse:h-9 pointer-coarse:min-w-9",
        destructive && !unavailable && "text-destructive hover:text-destructive",
        unavailable && "text-muted-foreground opacity-60"
      )}
    >
      <Icon className={cn("size-3.5 shrink-0", iconClassName)} />
      <span className="hidden @lg/plugin-detail-header:inline">{label}</span>
    </Button>
  )
}

interface DiagnosticsPreviewProps {
  entries: ReadonlyArray<{
    code: string
    severity: "warning" | "error"
    message: string
    hint?: string
    pointKind?: string
    pointId?: string
  }>
  t: (key: string, vars?: Record<string, string | number>) => string
}

// Inline diagnostics preview — latest 2 entries always visible, rest behind
// an expander. Renders nothing when there are no entries.
function DiagnosticsPreview({ entries, t }: DiagnosticsPreviewProps) {
  const [expanded, setExpanded] = useState(false)
  const latest = [...entries].reverse()
  const head = latest.slice(0, 2)
  const rest = latest.slice(2)
  const errorCount = entries.filter((e) => e.severity === "error").length

  return (
    <div
      className="rounded-md border border-amber-500/30 bg-amber-50/40 dark:bg-amber-950/20 p-2 space-y-1.5"
      data-testid="plugin-detail-diagnostics-preview"
      role="region"
      aria-label={t("diagnostics.ariaLabel")}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <AlertCircleIcon
          className={cn("size-3.5", errorCount > 0 ? "text-destructive" : "text-amber-600")}
        />
        <span>{t("diagnostics.title", { count: entries.length })}</span>
        {rest.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 ml-auto text-xs pointer-coarse:h-9"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? (
              <ChevronDownIcon className="size-3 mr-0.5" />
            ) : (
              <ChevronRightIcon className="size-3 mr-0.5" />
            )}
            {expanded
              ? t("diagnostics.collapse")
              : t("diagnostics.showMore", { count: rest.length })}
          </Button>
        )}
      </div>
      <ul className="space-y-1 text-xs">
        {head.map((entry, idx) => (
          <DiagnosticRow key={`head-${idx}`} entry={entry} />
        ))}
        {expanded && rest.map((entry, idx) => <DiagnosticRow key={`tail-${idx}`} entry={entry} />)}
      </ul>
    </div>
  )
}

function DiagnosticRow({ entry }: { entry: DiagnosticsPreviewProps["entries"][number] }) {
  return (
    <li className="flex items-start gap-1.5">
      <span
        className={cn(
          "mt-0.5 inline-block size-1.5 rounded-full shrink-0",
          entry.severity === "error" ? "bg-destructive" : "bg-amber-500"
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="font-medium break-words">{entry.message}</div>
        {entry.hint && <div className="text-muted-foreground text-[10px]">{entry.hint}</div>}
        {(entry.pointKind || entry.pointId) && (
          <code className="text-[10px] text-muted-foreground font-mono">
            {[entry.pointKind, entry.pointId].filter(Boolean).join(":")}
          </code>
        )}
      </div>
    </li>
  )
}
