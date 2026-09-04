"use client"

// Detail-pane header. Consolidates the plugin's identity (name + version +
// description) with status pill, signature, enable/disable toggle, and the
// primary actions that the row menu otherwise hides (Configure / Review
// permissions / Uninstall). Also surfaces the latest plugin-point
// diagnostic entries inline so failures aren't buried behind the Data tab.

import { useState, type ComponentType } from "react"
import { useTranslations } from "next-intl"
import {
  AlertCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  SettingsIcon,
  ShieldCheckIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { setPluginEnabledForHost } from "@/lib/plugin/core/set-plugin-enabled-for-host"
import { getPluginManager } from "@/lib/plugin/core/manager"
import { usePluginDiagnostics } from "@/hooks/plugins"
import { usePluginsStore } from "@/stores/plugins"
import type { PluginRow } from "@/lib/db/plugin-types"
import { PluginCompatibilityBadge } from "../_shared/plugin-compatibility-badge"
import { PluginSourceBadge } from "../plugin-source-badge"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import { PluginSignatureBadge, type SignatureState } from "../plugin-signature-badge"
import { PluginActivationProgress } from "../plugin-activation-progress"
import { PluginRuntimeWarnings, PluginStatusPill } from "../plugin-status-badge"
import { PluginAvatar } from "../plugin-avatar"

interface Props {
  plugin: PluginRow
}

export function PluginDetailHeader({ plugin }: Props) {
  const t = useTranslations("plugins.detail")
  const tCard = useTranslations("plugins.card")
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
  const description = (plugin.manifest as { description?: string }).description
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
      className="@container/plugin-detail-header shrink-0 space-y-1.5 border-b px-2.5 py-2"
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
            <h2 className="min-w-0 truncate text-sm leading-tight font-semibold">{plugin.name}</h2>
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
          onCheckedChange={(next) => void setPluginEnabledForHost(plugin.id, next)}
          aria-label={plugin.enabled ? tCard("disable") : tCard("enable")}
          data-testid="plugin-detail-enable-toggle"
          className="mt-0.5 shrink-0"
        />
      </div>

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
            onClick={() => setDeleteTarget({ pluginId: plugin.id, name: plugin.name })}
          />
        </div>
      </div>

      {/* The activation bar spans the header rather than sitting between two
          badges, where its own width fought the badges for the row. */}
      <PluginActivationProgress pluginId={plugin.id} pluginName={plugin.name} variant="detail" />

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
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "h-6 gap-1 px-1.5 text-xs",
        destructive && "text-destructive hover:text-destructive"
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
            className="h-5 px-1.5 ml-auto text-xs"
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
