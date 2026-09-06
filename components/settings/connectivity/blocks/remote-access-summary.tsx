"use client"

/**
 * Cloud & relay → the sentence above the routes.
 *
 * Plex answers "Remote Access" with one line before any setting, and the
 * word is what a user checks before leaving the house. The three routes out
 * of the building (relay, tunnel, overlay network) each get a row with the
 * state their own block would show, and `remoteAccessVerdict` turns them
 * into the line. Pure over props: the panel owns the reads.
 */

import { useTranslations } from "next-intl"
import { CircleIcon, CloudIcon, GlobeIcon, NetworkIcon } from "lucide-react"

import { SettingsBlock } from "@/components/settings/common/settings-block"
import { Badge } from "@/components/ui/badge"
import { meshProviderState, preferredMeshAddress, type MeshStatus } from "@/lib/connectivity/mesh"
import {
  remoteAccessVerdict,
  type RelayRouteState,
  type RemoteAccessVerdict,
} from "@/lib/connectivity/remote-access"
import { cn } from "@/lib/utils"

export interface RemoteAccessSummaryProps {
  isHost: boolean
  relay: RelayRouteState
  tunnel: { available: boolean; publicUrl: string | null }
  mesh: { available: boolean; status: MeshStatus | null }
}

const VERDICT_TONE: Record<RemoteAccessVerdict, string> = {
  anywhere: "text-emerald-600 dark:text-emerald-400",
  anywhereLegacy: "text-amber-600 dark:text-amber-400",
  meshOnly: "text-sky-600 dark:text-sky-400",
  lanOnly: "text-amber-600 dark:text-amber-400",
  unknown: "text-muted-foreground",
  notHost: "text-muted-foreground",
}

type RouteTone = "on" | "warn" | "off" | "muted"

const ROUTE_TONE: Record<RouteTone, string> = {
  on: "fill-emerald-500 text-emerald-500",
  warn: "fill-amber-500 text-amber-500",
  off: "fill-muted-foreground text-muted-foreground",
  muted: "fill-muted-foreground/50 text-muted-foreground/50",
}

function relayRow(relay: RelayRouteState): { key: string; tone: RouteTone } {
  switch (relay) {
    case "ready":
      return { key: "relayReady", tone: "on" }
    case "legacy":
      return { key: "relayLegacy", tone: "warn" }
    case "unreachable":
      return { key: "relayUnreachable", tone: "warn" }
    case "not-a-relay":
      return { key: "relayNotRelay", tone: "warn" }
    case "cors-blocked":
      return { key: "relayCorsBlocked", tone: "warn" }
    case "invalid-url":
      return { key: "relayInvalid", tone: "warn" }
    case "off":
      return { key: "relayOff", tone: "off" }
    case "unchecked":
      return { key: "relayUnchecked", tone: "muted" }
  }
}

export function RemoteAccessSummary({ isHost, relay, tunnel, mesh }: RemoteAccessSummaryProps) {
  const t = useTranslations("settings.connectivity.remoteAccess")
  const tMesh = useTranslations("settings.connectivity.mesh")
  const meshPick = preferredMeshAddress(mesh.status)
  const meshInstalled = mesh.status?.networks.find(
    (network) => meshProviderState(network) === "installed"
  )
  const verdict = remoteAccessVerdict({
    isHost,
    relay,
    tunnelOn: Boolean(tunnel.publicUrl),
    meshConnected: meshPick !== null,
  })
  const relayState = relayRow(relay)

  const tunnelRow: { text: string; tone: RouteTone } = !tunnel.available
    ? { text: t("routeState.tunnelDesktopOnly"), tone: "muted" }
    : tunnel.publicUrl
      ? { text: t("routeState.tunnelOn"), tone: "on" }
      : { text: t("routeState.tunnelOff"), tone: "off" }

  const meshRow: { text: string; tone: RouteTone } = !mesh.available
    ? { text: t("routeState.meshDesktopOnly"), tone: "muted" }
    : meshPick
      ? {
          text: t("routeState.meshOn", { provider: tMesh(`provider.${meshPick.provider}`) }),
          tone: "on",
        }
      : meshInstalled
        ? {
            text: t("routeState.meshInstalled", {
              provider: tMesh(`provider.${meshInstalled.provider}`),
            }),
            tone: "off",
          }
        : { text: t("routeState.meshOff"), tone: "off" }

  return (
    <SettingsBlock
      icon={<GlobeIcon />}
      title={t("title")}
      description={t("description")}
      badge={
        <Badge
          variant="outline"
          className={cn("gap-1.5", VERDICT_TONE[verdict])}
          data-testid="remote-access-verdict"
          data-verdict={verdict}
        >
          <CircleIcon className="size-2 fill-current" aria-hidden="true" />
          {t(`verdict.${verdict}`)}
        </Badge>
      }
      testid="remote-access-summary"
      settingId="connectivity-remote-access"
    >
      <dl className="grid grid-cols-1 gap-2 @md/settings-stack:grid-cols-3">
        <Route
          icon={<CloudIcon />}
          label={t("route.relay")}
          text={t(`routeState.${relayState.key}`)}
          tone={relayState.tone}
          testid="remote-access-relay"
        />
        <Route
          icon={<GlobeIcon />}
          label={t("route.tunnel")}
          text={tunnelRow.text}
          tone={tunnelRow.tone}
          detail={tunnel.publicUrl ?? undefined}
          testid="remote-access-tunnel"
        />
        <Route
          icon={<NetworkIcon />}
          label={t("route.mesh")}
          text={meshRow.text}
          tone={meshRow.tone}
          detail={meshPick?.address}
          testid="remote-access-mesh"
        />
      </dl>
    </SettingsBlock>
  )
}

function Route({
  icon,
  label,
  text,
  tone,
  detail,
  testid,
}: {
  icon: React.ReactNode
  label: string
  text: string
  tone: RouteTone
  detail?: string
  testid: string
}) {
  return (
    <div className="min-w-0 space-y-1" data-testid={testid} data-tone={tone}>
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3.5">
        {icon}
        {label}
      </dt>
      <dd className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-sm">
          <CircleIcon className={cn("size-2 shrink-0", ROUTE_TONE[tone])} aria-hidden="true" />
          {text}
        </span>
        {detail ? (
          <span className="break-all font-mono text-[11px] text-muted-foreground">{detail}</span>
        ) : null}
      </dd>
    </div>
  )
}
