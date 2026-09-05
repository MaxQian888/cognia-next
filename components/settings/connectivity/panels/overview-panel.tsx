"use client"

/**
 * Connectivity → Overview: what this shell is, what it is linked to, and how.
 *
 * Three runtimes, not two (see `status-bar-connectivity.tsx`): a shell that IS
 * the Host, a companion driving one, and a standalone browser with nothing
 * paired. Each row below answers for the runtime it is in rather than
 * pretending every shell has a "server".
 */

import { useCallback, useMemo, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { ArrowRightIcon, CircleIcon } from "lucide-react"
import { useLiveQuery } from "dexie-react-hooks"

import { SettingsBlock, SettingsStack } from "@/components/settings/common/settings-block"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useConnectionState } from "@/hooks/companion/use-connection-state"
import { useHostProfile } from "@/hooks/use-host-profile"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { eventPlaneState, type EventPlaneState } from "@/lib/companion/device-presence-registry"
import { transportTierTone } from "@/lib/companion/transport-tier-visuals"
import { listPairedDevices } from "@/lib/db/paired-devices"
import { transport } from "@/lib/tauri"
import type { CompanionPlaneHealth, TransportTier } from "@/lib/tauri/transport-companion"
import { cn } from "@/lib/utils"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"

import type { ConnectivityPanelId } from "../nav-config"

const TIER_KEY: Record<TransportTier, string> = {
  "rtc-direct": "rtcDirect",
  "rtc-relay": "rtcRelay",
  "ws-lan": "wsLan",
  "ws-tunnel": "wsTunnel",
  relay: "relay",
  offline: "offline",
}

export interface OverviewPanelProps {
  onNavigate: (panel: ConnectivityPanelId) => void
}

interface TransportProbe {
  onTierChange?: (handler: (next: TransportTier) => void) => () => void
  getActiveTier?: () => TransportTier
  onPlaneHealthChange?: (handler: (health: CompanionPlaneHealth) => void) => () => void
  getPlaneHealth?: () => CompanionPlaneHealth
}

interface LinkSnapshot {
  tier: TransportTier | null
  health: CompanionPlaneHealth | null
}

const NO_LINK: LinkSnapshot = Object.freeze({ tier: null, health: null })

/**
 * Memoised per (tier, health) pair so `useSyncExternalStore` sees a stable
 * object between changes: a fresh object on every read is an infinite loop.
 */
let lastLink: LinkSnapshot & { targetId?: string } = NO_LINK
function readLink(probe: TransportProbe, targetId: string | undefined): LinkSnapshot {
  const tier = probe.getActiveTier?.() ?? null
  const health = probe.getPlaneHealth?.() ?? null
  const same =
    lastLink.targetId === targetId &&
    lastLink.tier === tier &&
    lastLink.health?.rpc === health?.rpc &&
    lastLink.health?.events === health?.events
  if (!same) lastLink = { tier, health, targetId }
  return lastLink
}

export function OverviewPanel({ onNavigate }: OverviewPanelProps) {
  const t = useTranslations("settings.connectivity.overview")
  const tTier = useTranslations("mobile.transportTier")
  const profile = useHostProfile()
  const runtime = useRuntimeSnapshot()
  const connection = useConnectionState()
  const hosts = useRemoteHostStore((s) => s.hosts)
  const activeHostId = useRemoteHostStore((s) => s.activeHostId)
  const activeHost = hosts.find((host) => host.id === activeHostId) ?? null
  const devices = useLiveQuery(() => listPairedDevices(), [], [])

  const companion = runtime.target?.kind === "companion"
  const targetId = runtime.target?.id
  // Subscribed rather than polled, and read through `useSyncExternalStore` so
  // the first paint already carries the transport's current answer instead of
  // a null that an effect then corrects.
  const link = useSyncExternalStore(
    useCallback(
      (onChange: () => void) => {
        if (!companion) return () => undefined
        const probe = transport as unknown as TransportProbe
        const stopTier = probe.onTierChange?.(onChange)
        const stopHealth = probe.onPlaneHealthChange?.(onChange)
        return () => {
          stopTier?.()
          stopHealth?.()
        }
      },
      [companion]
    ),
    () => (companion ? readLink(transport as unknown as TransportProbe, targetId) : NO_LINK),
    () => NO_LINK
  )
  const tier = link.tier
  const health = link.health

  // The Host's view of every paired device's event plane, summarised. Only a
  // shell that IS a Host has this registry populated.
  const planes = useMemo(() => {
    const live = (devices ?? []).filter((device) => device.revokedAt === undefined)
    const counts: Record<EventPlaneState, number> = {
      ready: 0,
      replaying: 0,
      connecting: 0,
      degraded: 0,
      disconnected: 0,
    }
    for (const device of live) counts[eventPlaneState(device.deviceId)] += 1
    return { total: live.length, counts }
  }, [devices])

  // The companion's own event plane, in the same vocabulary the Host uses for
  // its devices, so the two sides of one link read the same word.
  const ownPlane: EventPlaneState | null = !companion
    ? null
    : health === null
      ? "disconnected"
      : health.events === "ready"
        ? "ready"
        : health.events === "replaying"
          ? "replaying"
          : health.events === "connecting"
            ? "connecting"
            : health.rpc === "ready"
              ? "degraded"
              : "disconnected"

  const hostMode: "host" | "companion" | "standalone" =
    profile === "desktop" || profile === "headless"
      ? "host"
      : profile === "web-standalone"
        ? "standalone"
        : "companion"

  const linkState = !companion ? "local" : (connection ?? "offline")

  return (
    <SettingsStack>
      <SettingsBlock
        title={t("runtimeTitle")}
        description={t("runtimeDescription")}
        testid="overview-runtime"
      >
        <dl className="grid grid-cols-1 gap-3 @md/settings-stack:grid-cols-2">
          <Row label={t("hostMode")} testid="overview-host-mode">
            <Badge variant={hostMode === "host" ? "default" : "secondary"}>
              {t(`hostModeValue.${hostMode}`)}
            </Badge>
            <span className="text-xs text-muted-foreground">{t(`profile.${profile}`)}</span>
          </Row>
          <Row label={t("link")} testid="overview-link">
            <span
              className={cn(
                "flex items-center gap-1.5 text-sm",
                linkState === "connected" || linkState === "local"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : linkState === "reconnecting"
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-muted-foreground"
              )}
            >
              <CircleIcon className="size-2 fill-current" aria-hidden="true" />
              {t(`linkValue.${linkState}`)}
            </span>
          </Row>
          <Row label={t("tier")} testid="overview-tier">
            {tier ? (
              <Badge variant="outline" className={cn("gap-1.5", transportTierTone(tier).chip)}>
                <CircleIcon
                  className={cn("size-2", transportTierTone(tier).dot)}
                  aria-hidden="true"
                />
                {tTier(TIER_KEY[tier])}
              </Badge>
            ) : (
              <span className="text-xs text-muted-foreground">{t("tierNotApplicable")}</span>
            )}
            {tier ? (
              <span className="text-xs text-muted-foreground">
                {tTier(`${TIER_KEY[tier]}Description`)}
              </span>
            ) : null}
          </Row>
          <Row label={t("activeHost")} testid="overview-active-host">
            {activeHost ? (
              <>
                <span className="text-sm">{activeHost.label}</span>
                <span className="break-all font-mono text-[11px] text-muted-foreground">
                  {activeHost.config.baseUrl}
                </span>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">
                {hostMode === "host" ? t("activeHostSelf") : t("activeHostNone")}
              </span>
            )}
          </Row>
        </dl>
      </SettingsBlock>

      <SettingsBlock
        title={t("eventPlaneTitle")}
        description={t("eventPlaneDescription")}
        testid="overview-event-plane"
      >
        {ownPlane ? (
          <p className="flex items-center gap-2 text-sm" data-testid="overview-own-plane">
            <PlaneDot state={ownPlane} />
            {t(`plane.${ownPlane}`)}
          </p>
        ) : null}
        {hostMode === "host" ? (
          <div className="space-y-1.5" data-testid="overview-device-planes">
            <p className="text-xs text-muted-foreground">
              {t("devicePlanes", { count: planes.total })}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(planes.counts) as EventPlaneState[])
                .filter((state) => planes.counts[state] > 0)
                .map((state) => (
                  <Badge key={state} variant="outline" className="gap-1.5">
                    <PlaneDot state={state} />
                    {t(`plane.${state}`)}
                    <span className="tabular-nums">{planes.counts[state]}</span>
                  </Badge>
                ))}
            </div>
          </div>
        ) : null}
        {ownPlane === "degraded" ? (
          <p className="text-xs text-amber-700 dark:text-amber-300" role="status">
            {t("degradedHint")}
          </p>
        ) : null}
      </SettingsBlock>

      <SettingsBlock title={t("shortcutsTitle")} testid="overview-shortcuts">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => onNavigate("pairing")}>
            {t("goPairing")}
            <ArrowRightIcon className="size-3.5" aria-hidden="true" />
          </Button>
          <Button size="sm" variant="outline" onClick={() => onNavigate("cloud-relay")}>
            {t("goRelay")}
            <ArrowRightIcon className="size-3.5" aria-hidden="true" />
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/devices">
              {t("goDevices")}
              <ArrowRightIcon className="size-3.5" aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </SettingsBlock>
    </SettingsStack>
  )
}

function Row({
  label,
  testid,
  children,
}: {
  label: string
  testid: string
  children: React.ReactNode
}) {
  return (
    <div className="min-w-0 space-y-1" data-testid={testid}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-col items-start gap-1">{children}</dd>
    </div>
  )
}

const PLANE_TONE: Record<EventPlaneState, string> = {
  ready: "fill-emerald-500 text-emerald-500",
  replaying: "fill-sky-500 text-sky-500",
  connecting: "fill-sky-500 text-sky-500",
  degraded: "fill-amber-500 text-amber-500",
  disconnected: "fill-muted-foreground text-muted-foreground",
}

function PlaneDot({ state }: { state: EventPlaneState }) {
  return <CircleIcon className={cn("size-2", PLANE_TONE[state])} aria-hidden="true" />
}
