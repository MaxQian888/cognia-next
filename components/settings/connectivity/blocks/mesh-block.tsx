"use client"

/**
 * Cloud & relay → overlay network (Tailscale, ZeroTier).
 *
 * Neither is ours and neither is managed here. The block says which client
 * is on this machine and what address it carries, offers that address as
 * the one invitations advertise (saved in the reachability preference the
 * Rust invitation and LAN-endpoint paths read), and shows the install steps
 * when nothing is there. Desktop-only for the same reason as mDNS: the
 * answer is about the desktop machine's own interfaces.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { DownloadIcon, NetworkIcon, RefreshCwIcon, ShieldAlertIcon } from "lucide-react"
import { toast } from "sonner"

import { TunnelInstallGuide } from "@/components/connectivity/tunnel-install-guide"
import { SettingsBlock, SettingsField } from "@/components/settings/common/settings-block"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { useHostAdminReachForCommand } from "@/hooks/connectivity/use-host-admin-reach"
import type { MeshSlice } from "@/hooks/connectivity/use-remote-access"
import {
  advertisedHostIsCarried,
  meshProviderState,
  preferredMeshAddress,
  type MeshNetwork,
  type MeshProvider,
} from "@/lib/connectivity/mesh"
import {
  loadReachabilityPrefs,
  patchReachabilityPrefs,
  type ReachabilityPrefs,
} from "@/lib/connectivity/reachability-prefs"
import { TOOL_HOMEPAGE } from "@/lib/connectivity/tunnel-install"
import { openExternal } from "@/lib/tauri/opener"
import { cn } from "@/lib/utils"

import { HostReachNotice } from "./host-reach-notice"

export interface MeshBlockProps {
  mesh: MeshSlice
  /** Test seams. */
  loadPrefs?: () => Promise<ReachabilityPrefs>
  patchPrefs?: (patch: Partial<ReachabilityPrefs>) => Promise<ReachabilityPrefs>
  open?: (url: string) => Promise<void>
}

const STATE_TONE: Record<ReturnType<typeof meshProviderState>, string> = {
  connected: "text-emerald-600 dark:text-emerald-400",
  installed: "text-amber-600 dark:text-amber-400",
  absent: "text-muted-foreground",
}

export function MeshBlock({
  mesh,
  loadPrefs = loadReachabilityPrefs,
  patchPrefs = patchReachabilityPrefs,
  open = openExternal,
}: MeshBlockProps) {
  const t = useTranslations("settings.connectivity.mesh")
  const reach = useHostAdminReachForCommand("companion_mesh_status")
  const desktop = reach.available
  const [prefs, setPrefs] = useState<ReachabilityPrefs | null>(null)
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [guideFor, setGuideFor] = useState<MeshProvider | null>(null)

  useEffect(() => {
    if (!desktop) return
    let live = true
    void loadPrefs()
      .then((next) => {
        if (live) setPrefs(next)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [desktop, loadPrefs])

  const pick = preferredMeshAddress(mesh.status)
  // The address as a string: a primitive dependency the memoization rule can
  // reason about, where the freshly-built `pick` object cannot be.
  const pickAddress = pick?.address ?? null
  const advertised = prefs?.advertiseHost?.trim() || null
  // Checked reflects "a host is saved", not "the saved host is still the one
  // we would pick": otherwise the switch reads off whenever the carried
  // address changes, and the only control that can clear it disappears
  // exactly when the daemon goes down and it needs clearing.
  const advertisingMesh = Boolean(advertised)
  const stale = Boolean(advertised && !advertisedHostIsCarried(mesh.status, advertised))
  const loopback = prefs?.bindLoopbackOnly === true
  // The address the control talks about: what we would advertise, or what is
  // already advertised when nothing is carried any more.
  const advertiseAddress = pickAddress ?? advertised

  const onAdvertise = useCallback(
    async (enabled: boolean) => {
      if (!desktop) return
      setSaving(true)
      try {
        const next = await patchPrefs({
          advertiseHost: enabled && pickAddress ? pickAddress : null,
        })
        setPrefs(next)
        toast.success(
          enabled && pickAddress
            ? t("advertiseSaved", { address: pickAddress })
            : t("advertiseCleared")
        )
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        setSaving(false)
      }
    },
    [desktop, patchPrefs, pickAddress, t]
  )

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await mesh.refresh()
    } finally {
      setRefreshing(false)
    }
  }, [mesh])

  return (
    <SettingsBlock
      icon={<NetworkIcon />}
      title={t("title")}
      description={t("description")}
      action={
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void onRefresh()}
          disabled={!desktop || refreshing}
          aria-label={t("refresh")}
          data-testid="mesh-refresh"
        >
          <RefreshCwIcon
            className={cn("size-3.5", refreshing && "animate-spin")}
            aria-hidden="true"
          />
        </Button>
      }
      testid="mesh-block"
      settingId="connectivity-mesh"
      contentClassName="space-y-3"
    >
      {reach.block ? <HostReachNotice block={reach.block} testid="mesh-reach" /> : null}
      {desktop && mesh.status ? (
        <ul className="space-y-2" data-testid="mesh-providers">
          {mesh.status.networks.map((network) => (
            <ProviderRow
              key={network.provider}
              network={network}
              showingGuide={guideFor === network.provider}
              onToggleGuide={() =>
                setGuideFor((current) => (current === network.provider ? null : network.provider))
              }
              onOpen={() => void open(TOOL_HOMEPAGE[network.provider])}
            />
          ))}
        </ul>
      ) : null}
      {desktop && guideFor ? (
        <TunnelInstallGuide
          tool={guideFor}
          onRecheck={onRefresh}
          rechecking={refreshing}
          testid="mesh-install-guide"
        />
      ) : null}
      {desktop && mesh.status && !pick ? (
        <p className="text-xs text-muted-foreground" data-testid="mesh-install-hint">
          {t("installHint")}
        </p>
      ) : null}
      {desktop && advertiseAddress ? (
        <SettingsField
          htmlFor="mesh-advertise"
          label={t("advertiseTitle")}
          description={
            pick
              ? t("advertiseDescription", { address: advertiseAddress })
              : t("advertiseDescriptionSaved", { address: advertiseAddress })
          }
          testid="mesh-advertise-field"
        >
          <Switch
            id="mesh-advertise"
            checked={advertisingMesh}
            onCheckedChange={(next) => void onAdvertise(next)}
            // With nothing carried the switch can still be turned off — that
            // is the only way back to detection.
            disabled={saving || loopback || (!pick && !advertised)}
            aria-label={
              pick
                ? t("advertiseLabel", { address: advertiseAddress })
                : t("advertiseLabelSaved", { address: advertiseAddress })
            }
          />
        </SettingsField>
      ) : null}
      {desktop && pick && loopback ? (
        <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="mesh-loopback-hint">
          {t("loopbackHint")}
        </p>
      ) : null}
      {desktop && stale && advertised ? (
        <p
          role="status"
          className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300"
          data-testid="mesh-advertise-stale"
        >
          <ShieldAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span>{t("advertiseStale", { address: advertised })}</span>
        </p>
      ) : null}
    </SettingsBlock>
  )
}

function ProviderRow({
  network,
  showingGuide,
  onToggleGuide,
  onOpen,
}: {
  network: MeshNetwork
  showingGuide: boolean
  onToggleGuide: () => void
  onOpen: () => void
}) {
  const t = useTranslations("settings.connectivity.mesh")
  const tInstall = useTranslations("settings.connectivity.tunnelInstall")
  const state = meshProviderState(network)
  const interfaces = Array.from(new Set(network.addresses.map((entry) => entry.interface))).join(
    ", "
  )
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-2"
      data-testid={`mesh-provider-${network.provider}`}
      data-state={state}
    >
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm">
          {t(`provider.${network.provider}`)}
          <Badge variant="outline" className={cn("text-[10px]", STATE_TONE[state])}>
            {t(`state.${state}`)}
          </Badge>
        </p>
        {network.addresses.length > 0 ? (
          <p className="break-all font-mono text-[11px] text-muted-foreground">
            {network.addresses.map((entry) => entry.address).join(", ")}
            <span className="ml-1 font-sans">
              · {t("addresses", { count: network.addresses.length, interfaces })}
            </span>
          </p>
        ) : null}
      </div>
      {state === "absent" ? (
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={onToggleGuide}
            data-testid={`mesh-guide-toggle-${network.provider}`}
            aria-expanded={showingGuide}
          >
            <DownloadIcon className="mr-1 size-3.5" aria-hidden="true" />
            {tInstall("title", { tool: t(`provider.${network.provider}`) })}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onOpen}
            aria-label={t("openDownload", { provider: t(`provider.${network.provider}`) })}
            data-testid={`mesh-open-${network.provider}`}
          >
            {tInstall("open")}
          </Button>
        </div>
      ) : null}
    </li>
  )
}
