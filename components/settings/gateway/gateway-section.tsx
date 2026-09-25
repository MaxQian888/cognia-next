"use client"

/**
 * Inbound LLM Gateway settings (desktop only).
 *
 * A master/detail shell over the persisted `gateway_*` config. It used to be
 * six stacked cards in one ~2000px scroll with no secondary nav; the panels now
 * live under `./panels/` and this file owns only the shared data (config,
 * status, cooldowns), the deep link, the restart action and the layout.
 *
 * Layout mirrors `appearance-section.tsx`: `SettingsMasterDetail` owns the nav/detail split: the rail tiers off
 * the pane's own width (full → compact → icon → drawer) rather than the
 * viewport, which this pane never gets — it is the window minus the app rail
 * minus the settings sidebar. The detail pane owns its
 * scroll and declares `@container/gateway-pane` so panel internals size off the
 * pane rather than the window.
 *
 * Status is polled while the page is visible. Before, it was read on mount and
 * after a key edit only, so the listener could crash or serve a thousand
 * requests while the Overview kept showing the numbers from when it opened —
 * and the animated counters there never had a new value to roll to.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, NetworkIcon } from "lucide-react"
import { toast } from "sonner"

import { MotionStatusSwap } from "@/components/chat/motion/motion-reveal"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { PanelTransition } from "@/components/settings/common/panel-transition"
import {
  SETTINGS_DETAIL_PANE_CLASS,
  SettingsMasterDetail,
} from "@/components/settings/common/settings-master-detail"
import { isGatewayAccountLocked } from "@/lib/gateway/status"
import { isTauri } from "@/lib/tauri"
import {
  gatewayGetConfig,
  gatewayGetStatus,
  gatewayListCooldowns,
  gatewayStart,
  gatewayStop,
  gatewayUpdateConfig,
} from "@/lib/tauri/gateway"
import { cn } from "@/lib/utils"
import {
  DEFAULT_GATEWAY_CONFIG,
  type GatewayBindTimeField,
  type GatewayConfig,
  type GatewayKeyCooldown,
  type GatewayStatus,
} from "@/types/gateway"

import { GatewayNav, type GatewayNavBadge } from "./components/gateway-nav"
import { GatewayRestartBanner } from "./components/restart-banner"
import {
  BIND_TIME_FIELD_PANEL,
  GATEWAY_NAV_GROUPS,
  GATEWAY_PANEL_PARAM,
  resolveGatewayPanel,
  type GatewayPanelId,
} from "./nav-config"
import { GatewayOverviewPanel } from "./panels/overview-panel"
import { GatewayListenerPanel } from "./panels/listener-panel"
import { GatewayKeysCard } from "./gateway-keys-card"
import { GatewayReliabilityPanel } from "./panels/reliability-panel"
import { GatewayUpstreamPanel } from "./panels/upstream-panel"
import { GatewayExposurePanel } from "./panels/exposure-panel"
import { GatewayLogViewer } from "./gateway-log-viewer"
import { GatewayRouteTicketsPanel } from "./panels/route-tickets-panel"
import { GatewayCustomPanel } from "./panels/custom-panel"

/** Shared handles every config-editing panel needs. */
export interface GatewayPanelContext {
  config: GatewayConfig
  status: GatewayStatus | null
  persist: (patch: Partial<GatewayConfig>) => Promise<void>
  replace: (config: GatewayConfig) => Promise<void>
  /** Bind-time fields saved but not yet served — see `BindTimeBadge`. */
  pendingRestartFields: readonly GatewayBindTimeField[]
}

/** How often live status is re-read while the page is visible. */
const STATUS_POLL_MS = 5_000
/** How often the cooldown list is refetched so the nav badge stays honest. */
const COOLDOWN_POLL_MS = 15_000

const NO_PENDING_FIELDS: readonly GatewayBindTimeField[] = []

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function isPageVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden"
}

export function GatewaySection() {
  const t = useTranslations("settings.gateway")
  const router = useRouter()
  const searchParams = useSearchParams()
  const desktop = isTauri()

  const [config, setConfig] = useState<GatewayConfig>(DEFAULT_GATEWAY_CONFIG)
  const [status, setStatus] = useState<GatewayStatus | null>(null)
  const [cooldowns, setCooldowns] = useState<GatewayKeyCooldown[]>([])
  const [starting, setStarting] = useState(false)
  const [restarting, setRestarting] = useState(false)

  const activePanel = resolveGatewayPanel(searchParams.get(GATEWAY_PANEL_PARAM))
  const pendingRestartFields = status?.pendingRestartFields ?? NO_PENDING_FIELDS

  const refreshStatus = useCallback(
    () =>
      gatewayGetStatus()
        .then(setStatus)
        .catch(() => {}),
    []
  )

  const refreshConfigAndStatus = useCallback(async () => {
    const [nextConfig, nextStatus] = await Promise.all([gatewayGetConfig(), gatewayGetStatus()])
    setConfig(nextConfig)
    setStatus(nextStatus)
  }, [])

  const refreshCooldowns = useCallback(() => gatewayListCooldowns().then(setCooldowns), [])

  useEffect(() => {
    if (!desktop) return
    // setState in promise callbacks — external-system updates, not synchronous
    // effect-body writes (react-hooks/set-state-in-effect).
    gatewayGetConfig()
      .then(setConfig)
      .catch(() => {})
    void refreshStatus()
    void refreshCooldowns().catch(() => {})
  }, [desktop, refreshStatus, refreshCooldowns])

  useEffect(() => {
    if (!desktop) return
    // Cooldowns lift on their own and the listener serves traffic on its own,
    // so both are re-read on a timer — but only while someone can see them.
    // A hidden window skips the tick and catches up the moment it is shown.
    const pollStatus = () => {
      if (isPageVisible()) void refreshStatus()
    }
    const pollCooldowns = () => {
      if (isPageVisible()) void refreshCooldowns().catch(() => {})
    }
    const onVisibility = () => {
      pollStatus()
      pollCooldowns()
    }
    const statusTimer = setInterval(pollStatus, STATUS_POLL_MS)
    const cooldownTimer = setInterval(pollCooldowns, COOLDOWN_POLL_MS)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      clearInterval(statusTimer)
      clearInterval(cooldownTimer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [desktop, refreshStatus, refreshCooldowns])

  // Mirror of `config` for `persist`, which must read the *current* config
  // synchronously without re-creating itself on every edit. Reading it out of a
  // `setConfig` updater does not work: React only runs updaters eagerly when the
  // fiber has no pending lanes, and the status/cooldown polls above keep one in
  // flight — so the read fell back to DEFAULT_GATEWAY_CONFIG and a single toggle
  // shipped `port`, `allowlist`, `exposedModels` and `disableKeywords` back to
  // their defaults.
  //
  // Closing over `config` instead would drop a patch whenever two land before
  // the next render — the second would start from the pre-first snapshot — so
  // the ref is the coalescing point, not just a staleness dodge.
  const configRef = useRef(config)
  // eslint-disable-next-line react-hooks/refs -- sync during render so `persist` reads the config of the render it was called from; the same ref-tracked-async-state pattern as `components/settings/shortcuts-section.tsx`.
  configRef.current = config

  const persist = useCallback(
    async (patch: Partial<GatewayConfig>) => {
      const next: GatewayConfig = { ...configRef.current, ...patch }
      try {
        await gatewayUpdateConfig(next)
        configRef.current = next
        setConfig(next)
        // Rust decides whether the edit is served live or pending a restart;
        // re-read rather than guess.
        await refreshStatus()
      } catch (e) {
        await refreshConfigAndStatus().catch(() => {})
        toast.error(errorMessage(e))
      }
    },
    [refreshConfigAndStatus, refreshStatus]
  )

  const replace = useCallback(
    async (next: GatewayConfig) => {
      if (next.enabled && !status?.hasToken) {
        const error = new Error(t("requiresKey"))
        toast.error(error.message)
        throw error
      }
      try {
        await gatewayUpdateConfig(next)
        if (next.enabled !== Boolean(status?.running)) {
          if (next.enabled) await gatewayStart()
          else await gatewayStop()
        }
        configRef.current = next
        setConfig(next)
        await refreshConfigAndStatus()
        toast.success(t("customApplied"))
      } catch (e) {
        await refreshConfigAndStatus().catch(() => {})
        toast.error(errorMessage(e))
        throw e
      }
    },
    [refreshConfigAndStatus, status, t]
  )

  const onToggleEnabled = useCallback(
    async (nextEnabled: boolean) => {
      if (nextEnabled && !status?.hasToken) {
        toast.error(t("requiresKey"))
        return
      }
      setStarting(true)
      try {
        if (nextEnabled) await gatewayStart()
        else await gatewayStop()
        await refreshConfigAndStatus()
      } catch (e) {
        toast.error(errorMessage(e))
      } finally {
        setStarting(false)
      }
    },
    [status?.hasToken, refreshConfigAndStatus, t]
  )

  const onRestart = useCallback(async () => {
    setRestarting(true)
    try {
      await gatewayStop()
      await gatewayStart()
      toast.success(t("restarted"))
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      // Either way the authoritative state changed (a failed start leaves the
      // listener stopped), so the banner and the switch must re-read it.
      await refreshConfigAndStatus().catch(() => {})
      setRestarting(false)
    }
  }, [refreshConfigAndStatus, t])

  const onSelect = useCallback(
    (id: GatewayPanelId) => {
      const next = new URLSearchParams(searchParams.toString())
      next.set(GATEWAY_PANEL_PARAM, id)
      router.replace(`?${next.toString()}`, { scroll: false })
    },
    [router, searchParams]
  )

  const badges = useMemo(() => {
    const result: Partial<Record<GatewayPanelId, GatewayNavBadge>> = {}
    // Without a key the listener cannot start at all — surface that from any
    // panel rather than only on the one card that mentions it.
    if (status && !status.hasToken) {
      result.keys = {
        text: "!",
        variant: "destructive",
        ariaLabel: t("nav.badgeNoKeyAria"),
      }
    }
    if (cooldowns.length > 0) {
      result.upstream = {
        text: String(cooldowns.length),
        variant: cooldowns.some((c) => c.permanent) ? "destructive" : "secondary",
        ariaLabel: t("nav.badgeParkedKeysAria", { count: cooldowns.length }),
      }
    }
    for (const field of pendingRestartFields) {
      result[BIND_TIME_FIELD_PANEL[field]] = {
        text: "!",
        variant: "destructive",
        ariaLabel: t("nav.badgeRestartRequiredAria"),
      }
    }
    return result
  }, [status, cooldowns, pendingRestartFields, t])

  if (!desktop) {
    return (
      <Alert>
        <AlertTriangleIcon />
        <AlertDescription>{t("desktopOnlyNotice")}</AlertDescription>
      </Alert>
    )
  }

  const panelContext: GatewayPanelContext = {
    config,
    status,
    persist,
    replace,
    pendingRestartFields,
  }

  const navNode = (
    <GatewayNav
      groups={GATEWAY_NAV_GROUPS}
      activeId={activePanel}
      onSelect={onSelect}
      badges={badges}
    />
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-4" data-testid="gateway-section">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <Label className="flex items-center gap-2">
            <NetworkIcon className="size-4" />
            {t("title")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
        {status ? <GatewayHeaderStatus status={status} /> : null}
      </div>

      <SettingsMasterDetail
        nav={() => navNode}
        navTitle={t("nav.title")}
        mobileTriggerLabel={t("nav.mobileTrigger")}
        activeKey={activePanel}
        activeLabel={t(`nav.items.${activePanel}.label`)}
        navWidth={320}
        triggerTestId="gateway-mobile-nav-trigger"
      >
        {/* `@container/gateway-shell` sizes the banner; the body below keeps
            its own `@container/gateway-pane` for the panels. Both are the
            detail pane, not the window. */}
        <div className={cn(SETTINGS_DETAIL_PANE_CLASS, "@container/gateway-shell")}>
          <GatewayRestartBanner
            pending={pendingRestartFields}
            restarting={restarting}
            onRestart={() => void onRestart()}
          />
          <div
            className="min-h-0 flex-1 overflow-y-auto p-3 @container/gateway-pane @lg/gateway-shell:p-4"
            data-testid="gateway-panel-body"
          >
            <PanelTransition activeKey={activePanel}>
              {/* A component, not a `renderPanel(...)` call: `panelContext`
                  carries `persist`, which reads `configRef`, and calling a
                  plain function here makes that a render-phase ref access.
                  Letting React own the call also gives each panel its own
                  fiber, which is what `PanelTransition` keys on anyway. */}
              <GatewayPanelBody
                panel={activePanel}
                panelContext={panelContext}
                cooldowns={cooldowns}
                starting={starting}
                onToggleEnabled={onToggleEnabled}
                refreshStatus={refreshStatus}
                refreshCooldowns={refreshCooldowns}
              />
            </PanelTransition>
          </div>
        </div>
      </SettingsMasterDetail>
    </div>
  )
}

/**
 * Run state beside the section title, so "is it up, and where" is answered
 * from every panel — the Overview switch is one click away at most, but the
 * question comes up on all nine.
 */
function GatewayHeaderStatus({ status }: { status: GatewayStatus }) {
  const t = useTranslations("settings.gateway")
  const running = status.running

  return (
    <MotionStatusSwap swapKey={running ? `on-${status.boundPort}` : "off"}>
      <Badge
        variant={running ? "success" : "outline"}
        className="gap-1.5 font-normal tabular-nums"
        data-testid="gateway-header-status"
      >
        <span
          aria-hidden
          className={cn("size-1.5 rounded-full", running ? "bg-current" : "bg-muted-foreground/60")}
        />
        {!running
          ? t("badgeStopped")
          : status.boundPort != null
            ? t("headerRunningOn", { port: status.boundPort })
            : t("badgeRunning")}
      </Badge>
    </MotionStatusSwap>
  )
}

interface RenderArgs {
  panel: GatewayPanelId
  panelContext: GatewayPanelContext
  cooldowns: GatewayKeyCooldown[]
  starting: boolean
  onToggleEnabled: (next: boolean) => Promise<void>
  refreshStatus: () => Promise<void>
  refreshCooldowns: () => Promise<void>
}

function GatewayPanelBody(args: RenderArgs) {
  const {
    panel,
    panelContext,
    cooldowns,
    starting,
    onToggleEnabled,
    refreshStatus,
    refreshCooldowns,
  } = args
  switch (panel) {
    case "overview":
      return (
        <GatewayOverviewPanel
          ctx={panelContext}
          starting={starting}
          onToggleEnabled={onToggleEnabled}
          onRefreshStatus={refreshStatus}
        />
      )
    case "listener":
      return <GatewayListenerPanel ctx={panelContext} />
    case "keys":
      return (
        <GatewayKeysCard
          legacyKeyCount={panelContext.status?.legacyKeyCount}
          accountLocked={isGatewayAccountLocked(panelContext.status)}
          onChanged={() => void refreshStatus()}
        />
      )
    case "reliability":
      return <GatewayReliabilityPanel ctx={panelContext} />
    case "upstream":
      return (
        <GatewayUpstreamPanel
          ctx={panelContext}
          cooldowns={cooldowns}
          onRefreshCooldowns={refreshCooldowns}
        />
      )
    case "exposure":
      return <GatewayExposurePanel ctx={panelContext} />
    case "logs":
      return <GatewayLogViewer />
    case "tickets":
      return <GatewayRouteTicketsPanel />
    case "custom":
      return <GatewayCustomPanel ctx={panelContext} />
  }
}
