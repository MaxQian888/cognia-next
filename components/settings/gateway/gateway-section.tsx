"use client"

/**
 * Inbound LLM Gateway settings (desktop only).
 *
 * A master/detail shell over the persisted `gateway_*` config. It used to be
 * six stacked cards in one ~2000px scroll with no secondary nav; the panels now
 * live under `./panels/` and this file owns only the shared data (config,
 * status, cooldowns), the deep link, and the layout.
 *
 * Layout mirrors `appearance-section.tsx`: `md:grid-cols-[320px_1fr]`, the nav
 * collapsing into a left Sheet below `md`, and a detail pane that owns its
 * scroll and declares `@container/gateway-pane` so panel internals size off the
 * pane rather than the window.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, MenuIcon, NetworkIcon } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { PanelTransition } from "@/components/settings/common/panel-transition"
import { isTauri } from "@/lib/tauri"
import {
  gatewayGetConfig,
  gatewayGetStatus,
  gatewayListCooldowns,
  gatewayStart,
  gatewayStop,
  gatewayUpdateConfig,
} from "@/lib/tauri/gateway"
import {
  DEFAULT_GATEWAY_CONFIG,
  type GatewayConfig,
  type GatewayKeyCooldown,
  type GatewayStatus,
} from "@/types/gateway"

import { GatewayNav, type GatewayNavBadge } from "./components/gateway-nav"
import {
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
  restartRequired: boolean
}

/** How often the cooldown list is refetched so the nav badge stays honest. */
const COOLDOWN_POLL_MS = 15_000

export function GatewaySection() {
  const t = useTranslations("settings.gateway")
  const router = useRouter()
  const searchParams = useSearchParams()
  const desktop = isTauri()

  const [config, setConfig] = useState<GatewayConfig>(DEFAULT_GATEWAY_CONFIG)
  const [status, setStatus] = useState<GatewayStatus | null>(null)
  const [cooldowns, setCooldowns] = useState<GatewayKeyCooldown[]>([])
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false)
  const [starting, setStarting] = useState(false)
  const [restartRequired, setRestartRequired] = useState(false)

  const activePanel = resolveGatewayPanel(searchParams.get(GATEWAY_PANEL_PARAM))

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

  const refreshCooldowns = useCallback(
    () =>
      gatewayListCooldowns()
        .then(setCooldowns)
        .catch(() => {}),
    []
  )

  useEffect(() => {
    if (!desktop) return
    // setState in promise callbacks — external-system updates, not synchronous
    // effect-body writes (react-hooks/set-state-in-effect).
    gatewayGetConfig()
      .then(setConfig)
      .catch(() => {})
    void refreshStatus()
    void refreshCooldowns()
  }, [desktop, refreshStatus, refreshCooldowns])

  useEffect(() => {
    if (!desktop) return
    // Cooldowns lift on their own, so the badge would otherwise sit stale until
    // the user opened the panel and hit refresh by hand.
    const timer = setInterval(() => void refreshCooldowns(), COOLDOWN_POLL_MS)
    return () => clearInterval(timer)
  }, [desktop, refreshCooldowns])

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
      const previous = configRef.current
      const next: GatewayConfig = { ...previous, ...patch }
      try {
        await gatewayUpdateConfig(next)
        configRef.current = next
        setConfig(next)
        if (
          status?.running &&
          next.enabled &&
          (next.port !== previous.port ||
            next.bindInterface !== previous.bindInterface ||
            next.allowlist.join("\n") !== previous.allowlist.join("\n"))
        ) {
          setRestartRequired(true)
        }
      } catch (e) {
        await refreshConfigAndStatus().catch(() => {})
        toast.error(e instanceof Error ? e.message : String(e))
      }
    },
    [refreshConfigAndStatus, status]
  )

  const replace = useCallback(
    async (next: GatewayConfig) => {
      const previous = configRef.current
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
        if (
          status?.running &&
          next.enabled &&
          (next.port !== previous.port ||
            next.bindInterface !== previous.bindInterface ||
            next.allowlist.join("\n") !== previous.allowlist.join("\n"))
        ) {
          setRestartRequired(true)
        }
        await refreshConfigAndStatus()
        toast.success(t("customApplied"))
      } catch (e) {
        await refreshConfigAndStatus().catch(() => {})
        toast.error(e instanceof Error ? e.message : String(e))
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
        toast.error(e instanceof Error ? e.message : String(e))
      } finally {
        setStarting(false)
      }
    },
    [status?.hasToken, refreshConfigAndStatus, t]
  )

  const onSelect = useCallback(
    (id: GatewayPanelId) => {
      const next = new URLSearchParams(searchParams.toString())
      next.set(GATEWAY_PANEL_PARAM, id)
      router.replace(`?${next.toString()}`, { scroll: false })
      setMobileSheetOpen(false)
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
    if (restartRequired) {
      result.listener = {
        text: "!",
        variant: "destructive",
        ariaLabel: t("nav.badgeRestartRequiredAria"),
      }
      result.custom = {
        text: "!",
        variant: "destructive",
        ariaLabel: t("nav.badgeRestartRequiredAria"),
      }
    }
    return result
  }, [status, cooldowns, restartRequired, t])

  if (!desktop) {
    return (
      <Alert>
        <AlertTriangleIcon />
        <AlertDescription>{t("desktopOnlyNotice")}</AlertDescription>
      </Alert>
    )
  }

  const panelContext: GatewayPanelContext = { config, status, persist, replace, restartRequired }

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
        <div className="space-y-1">
          <Label className="flex items-center gap-2">
            <NetworkIcon className="size-4" />
            {t("title")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-4 md:grid-cols-[320px_minmax(0,1fr)] md:grid-rows-1">
        {/* Desktop nav */}
        <div className="hidden min-h-0 md:flex md:flex-col md:overflow-hidden md:rounded-lg md:border">
          {navNode}
        </div>

        {/* Below md the nav lives in a Sheet; the bar shows where you are. */}
        <div className="flex items-center gap-2 md:hidden">
          <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
            <SheetTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 gap-1.5"
                data-testid="gateway-mobile-nav-trigger"
              >
                <MenuIcon className="size-4" />
                {t("nav.mobileTrigger")}
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[300px] p-0">
              <SheetHeader className="px-3 pt-3">
                <SheetTitle className="text-sm">{t("nav.title")}</SheetTitle>
              </SheetHeader>
              {navNode}
            </SheetContent>
          </Sheet>
          <p className="min-w-0 flex-1 truncate text-sm font-medium">
            {t(`nav.items.${activePanel}.label`)}
          </p>
        </div>

        {/* `@container/gateway-pane`: the detail pane is a fraction of the
            window, so anything multi-column inside a panel must size off this
            box rather than the viewport. */}
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border">
          <div
            className="min-h-0 flex-1 overflow-y-auto p-3 @container/gateway-pane"
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
                onRestarted={async () => {
                  setRestartRequired(false)
                  await refreshConfigAndStatus()
                }}
              />
            </PanelTransition>
          </div>
        </div>
      </div>
    </div>
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
  onRestarted: () => Promise<void>
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
    onRestarted,
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
      return <GatewayListenerPanel ctx={panelContext} onRestarted={onRestarted} />
    case "keys":
      return <GatewayKeysCard onChanged={() => void refreshStatus()} />
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
