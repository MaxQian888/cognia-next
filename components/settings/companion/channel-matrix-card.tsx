"use client"

/**
 * "Which channels does this desktop answer on, and can anything actually reach
 * it" — in one table.
 *
 * The four channels were spread across four cards that each knew only their own
 * switch, and the reachability probe printed a flat list of URLs with no idea
 * which channel each belonged to. This card joins them: state, address, and the
 * last probe result per channel, plus the distinction the old layout hid —
 * a channel that is switched *on* but cannot work (server stopped, bound to
 * loopback, WebRTC with no rendezvous server) reads as blocked, not as off.
 *
 * Read-only. Each channel's switch stays on its own card; duplicating controls
 * here would mean two places to keep in step.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { GlobeIcon, RadioTowerIcon, RouteIcon, WifiIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SettingsBlock } from "@/components/settings/common/settings-block"
import { isTauri, transport } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { useSettingsStore } from "@/stores/settings"

import {
  buildChannelRows,
  summarizeChannels,
  type ChannelId,
  type ChannelRow,
  type ProbeResult,
  type ServerSnapshot,
} from "./channel-rows"

const CHANNEL_ICONS: Record<ChannelId, React.ComponentType<{ className?: string }>> = {
  lan: WifiIcon,
  mdns: RadioTowerIcon,
  tunnel: RouteIcon,
  webrtc: GlobeIcon,
}

/** Injectable so the card is testable without a Tauri host. */
export interface ChannelMatrixDeps {
  fetchServerStatus?: () => Promise<ServerSnapshot>
  fetchMdnsOn?: () => Promise<boolean>
  fetchTunnelUrl?: () => Promise<string | null>
  probeReachability?: () => Promise<ProbeResult[]>
  isDesktop?: () => boolean
}

const defaultDeps: Required<ChannelMatrixDeps> = {
  fetchServerStatus: () => transport.call<ServerSnapshot>("companion_server_status"),
  fetchMdnsOn: () => transport.call<boolean>("companion_mdns_status"),
  fetchTunnelUrl: () =>
    transport
      .call<{ publicUrl: string } | null>("companion_tunnel_current")
      .then((info) => info?.publicUrl ?? null),
  probeReachability: () => transport.call<ProbeResult[]>("companion_test_local_reachability"),
  isDesktop: isTauri,
}

const STOPPED: ServerSnapshot = { running: false, bindMode: "none", boundPort: null }

export function ChannelMatrixCard(deps: ChannelMatrixDeps = {}) {
  const t = useTranslations("mobile.companion.channels")
  const d = { ...defaultDeps, ...deps }
  const desktop = d.isDesktop()

  const settings = useSettingsStore((s) => s.settings)
  const [server, setServer] = useState<ServerSnapshot>(STOPPED)
  const [mdnsOn, setMdnsOn] = useState(false)
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null)
  const [probes, setProbes] = useState<ProbeResult[]>([])
  const [probing, setProbing] = useState(false)

  useEffect(() => {
    if (!desktop) return
    let live = true
    // setState from promise callbacks — external-system reads, not synchronous
    // effect-body writes (react-hooks/set-state-in-effect).
    void d
      .fetchServerStatus()
      .then((s) => live && setServer(s))
      .catch(() => {})
    void d
      .fetchMdnsOn()
      .then((on) => live && setMdnsOn(on))
      .catch(() => {})
    void d
      .fetchTunnelUrl()
      .then((url) => live && setTunnelUrl(url))
      .catch(() => {})
    return () => {
      live = false
    }
    // The deps object is rebuilt every render; the identity of its members is
    // what matters and those are module constants in production.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop])

  const onProbe = useCallback(async () => {
    setProbing(true)
    try {
      setProbes(await d.probeReachability())
    } catch (err) {
      toast.error(t("probeFailed", { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setProbing(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t])

  const rows = buildChannelRows({
    server,
    mdnsOn,
    tunnelUrl,
    webrtcEnabled: settings?.webrtcEnabled ?? true,
    signalingUrl: settings?.signalingUrl,
    probes,
  })
  const summary = summarizeChannels(rows)

  return (
    <SettingsBlock
      title={t("title")}
      description={t("description")}
      badge={
        <Badge
          variant={
            summary === "reachable" ? "default" : summary === "blocked" ? "destructive" : "outline"
          }
          data-testid="channel-matrix-summary"
        >
          {t(`summary.${summary}`)}
        </Badge>
      }
      testid="channel-matrix-card"
      settingId="companion-channels"
      contentClassName="space-y-3"
    >
      <div className="space-y-1.5">
        {rows.map((row) => (
          <ChannelRowView key={row.id} row={row} />
        ))}
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={onProbe}
        disabled={!desktop || probing}
        data-testid="channel-matrix-probe"
      >
        {probing ? t("probing") : t("probeButton")}
      </Button>
      {!desktop && <p className="text-xs text-muted-foreground">{t("desktopOnly")}</p>}
    </SettingsBlock>
  )
}

function ChannelRowView({ row }: { row: ChannelRow }) {
  const t = useTranslations("mobile.companion.channels")
  const Icon = CHANNEL_ICONS[row.id]

  const detail = row.blockedReason
    ? t(`blocked.${row.blockedReason}`)
    : row.reachable === true
      ? t("probeOk", { ms: row.latencyMs ?? 0 })
      : row.reachable === false
        ? t("probeFailedShort", { message: row.probeError ?? t("noReason") })
        : (row.address ?? t(`state.${row.state}`))

  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded border px-3 py-2 text-xs",
        row.state === "live" && "border-emerald-500/40 bg-emerald-500/5",
        row.state === "blocked" && "border-amber-500/40 bg-amber-500/5",
        row.state === "off" && "border-border bg-muted/20"
      )}
      data-testid={`channel-row-${row.id}`}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="font-medium">{t(`channel.${row.id}`)}</div>
        <div className="truncate font-mono text-[10px] text-muted-foreground">{detail}</div>
        {row.address && detail !== row.address && (
          <div className="truncate font-mono text-[10px] text-muted-foreground/70">
            {row.address}
          </div>
        )}
      </div>
      <Badge
        variant={
          row.state === "live" ? "default" : row.state === "blocked" ? "destructive" : "outline"
        }
        className="shrink-0"
      >
        {t(`state.${row.state}`)}
      </Badge>
    </div>
  )
}
