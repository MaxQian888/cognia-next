"use client"

/**
 * Status-bar runtime connection center. The compact trigger reports whether the
 * active execution target is local or reachable; its popover keeps the device's
 * network, Host link, transport tier, and recovery actions separate so a green
 * Wi-Fi glyph never ambiguously means all four things at once.
 *
 * # A desktop driving a remote host is not "local"
 *
 * The runtime snapshot's `target` describes what kind of shell this is, and on
 * a Tauri desktop it stays `null` (this shell IS a Host) even while the
 * remote-host store has repointed every execution call at another machine:
 * `CompanionOutboundRunnerProvider` only publishes that host's manifest into
 * `runtimeSnapshot.host`, never a target. Reading remoteness from `target`
 * alone therefore painted "Local runtime / This desktop" and a laptop glyph
 * one segment away from the execution-host switcher naming the remote. So on
 * Tauri the remote-host store decides first: with an active host, the segment
 * describes THAT host from the store's own state, and offers the two moves
 * that state calls for, going back to local and managing hosts.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import {
  ActivityIcon,
  AlertCircleIcon,
  CloudIcon,
  KeyRoundIcon,
  LaptopIcon,
  LinkIcon,
  RefreshCwIcon,
  ServerIcon,
  SettingsIcon,
  ShieldCheckIcon,
  WifiIcon,
  WifiOffIcon,
} from "lucide-react"
import { formatRelative } from "@cognia/time"

import { RuntimeTargetMenuSection } from "@/components/account/runtime-target-menu-section"
import { hostTone } from "@/components/devices/execution-host-switcher"
import { SITE_TONE_DOT, SITE_TONE_TEXT, type SiteTone } from "@/components/sites/site-status"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { useNetworkStatus } from "@/hooks/use-network-status"
import { useConnectionState } from "@/hooks/companion/use-connection-state"
import { usePlatform } from "@/hooks/use-platform"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { useExecutionHostSwitch } from "@/hooks/devices/use-execution-host-switch"
import {
  activeAccountNamespace,
  companionCredentialBook,
  type CompanionHostRecord,
} from "@/lib/companion/credential-book"
import type { OperationAvailability } from "@/lib/runtime/operation-availability"
import { resolveRuntimeRecovery } from "@/lib/runtime/recovery-resolver"
import { settingsHref } from "@/lib/settings/deep-link"
import { transport } from "@/lib/tauri"
import type { CompanionPlaneHealth, TransportTier } from "@/lib/tauri/transport-companion"
import {
  getActiveRemoteTransport,
  subscribeActiveRemoteTransport,
} from "@/lib/tauri/transport-routing"
import type { EventPlaneState } from "@/lib/companion/device-presence-registry"
import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"
import { useUIStore } from "@/stores/ui/ui-store"

type ConnState = "online" | "offline" | "reconnecting"

interface LoadedHostRecord {
  hostId: string
  record: CompanionHostRecord
}

/** Settings → Connectivity, opened on the Remote hosts panel. */
export const REMOTE_HOSTS_SETTINGS_HREF = settingsHref("connectivity", {
  params: { connectivityPanel: "remote-hosts" },
})

export function StatusBarConnectivity() {
  const platform = usePlatform()
  const hosts = useRemoteHostStore((s) => s.hosts)
  const activeHostId = useRemoteHostStore((s) => s.activeHostId)
  // Only a desktop drives a remote host through this store; a paired phone or
  // browser describes its Host through the runtime target as before.
  const drivenHost =
    platform === "tauri" && activeHostId
      ? (hosts.find((host) => host.id === activeHostId) ?? null)
      : null
  if (drivenHost) return <DrivenHostConnectivity host={drivenHost} />
  return <RuntimeConnectivity platform={platform} />
}

const TONE_BADGE: Record<SiteTone, "success" | "warning" | "destructive" | "secondary"> = {
  success: "success",
  info: "secondary",
  warning: "warning",
  danger: "destructive",
  neutral: "secondary",
}

interface TierProbe {
  getActiveTier?: () => TransportTier
  onTierChange?: (handler: (next: TransportTier) => void) => () => void
}

/**
 * The active remote host's transport tier, read from that host's own
 * `CompanionTransport`. The shared `transport` export on a desktop is the
 * routing proxy over the local Tauri transport, which has no tier at all, so
 * asking it (as the companion branch does) would always answer "negotiating".
 */
function useDrivenTier(): TransportTier | null {
  const remote = useSyncExternalStore(
    subscribeActiveRemoteTransport,
    getActiveRemoteTransport,
    () => null
  )
  const probe = remote as unknown as TierProbe | null
  const subscribe = useCallback(
    (onChange: () => void) => probe?.onTierChange?.(() => onChange()) ?? (() => undefined),
    [probe]
  )
  return useSyncExternalStore(
    subscribe,
    () => probe?.getActiveTier?.() ?? null,
    () => null
  )
}

function DrivenHostConnectivity({ host }: { host: RemoteHost }) {
  const t = useTranslations("desktop.statusBar")
  const tState = useTranslations("devices.executionHost.state")
  const router = useRouter()
  const runtimeSnapshot = useRuntimeSnapshot()
  const { requestSwitch, dialog } = useExecutionHostSwitch()
  const tier = useDrivenTier()
  const [open, setOpen] = useState(false)

  const tone = hostTone(host)
  const stateLabel = tState(host.connectionState)
  const triggerLabel = t("connectionCenter.drivenAria", { label: host.label, state: stateLabel })
  // The capability count is the manifest the outbound-runner provider
  // published for this host. Until it arrives (or when the host could not
  // produce one) it is "checking", not zero: zero would read as a host that
  // advertised nothing.
  const operations = runtimeSnapshot.host?.operations.length

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={triggerLabel}
            title={triggerLabel}
            data-testid="status-connectivity"
            data-driven-host={host.id}
            data-tone={tone}
            className="flex h-6 shrink-0 items-center gap-1 px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ServerIcon aria-hidden className={cn("size-3", SITE_TONE_TEXT[tone])} />
            <span
              aria-hidden
              className={cn("inline-block size-1.5 rounded-full", SITE_TONE_DOT[tone])}
            />
            <span className="hidden max-w-32 truncate lg:inline">{host.label}</span>
          </button>
        </PopoverTrigger>

        <PopoverContent align="start" side="top" sideOffset={4} className="w-96 p-0">
          <PopoverHeader className="p-3">
            <div className="flex items-start gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                <ServerIcon className="size-4" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <PopoverTitle>{t("connectionCenter.title")}</PopoverTitle>
                <PopoverDescription className="truncate">{host.label}</PopoverDescription>
              </div>
              <Badge variant={TONE_BADGE[tone]} data-testid="connection-status-badge">
                {stateLabel}
              </Badge>
            </div>
          </PopoverHeader>

          <Separator />
          <p className="px-3 pt-3 text-xs text-muted-foreground" data-testid="driven-host-scope">
            {t("connectionCenter.drivenScope", { label: host.label })}
          </p>
          <dl className="flex flex-col gap-2 p-3 text-xs">
            <ConnectionRow
              icon={ServerIcon}
              label={t("connectionCenter.runtimeTarget")}
              value={t("connectionCenter.remoteRuntime")}
            />
            <ConnectionRow
              icon={ServerIcon}
              label={t("connectionCenter.activeHost")}
              value={host.label}
            />
            <ConnectionRow
              icon={LinkIcon}
              label={t("connectionCenter.address")}
              value={host.config.baseUrl}
              title={host.config.baseUrl}
            />
            <ConnectionRow
              icon={ActivityIcon}
              label={t("connectionCenter.hostLink")}
              value={stateLabel}
            />
            <ConnectionRow
              icon={RefreshCwIcon}
              label={t("connectionCenter.transport")}
              value={t(`connectionCenter.tier.${tier ?? "unknown"}`)}
            />
            {host.config.serverVersion ? (
              <ConnectionRow
                icon={ServerIcon}
                label={t("connectionCenter.serverVersion")}
                value={host.config.serverVersion}
              />
            ) : null}
            <ConnectionRow
              icon={ShieldCheckIcon}
              label={t("connectionCenter.capabilities")}
              value={
                operations === undefined
                  ? t("connectionCenter.protocolStatus.checking")
                  : t("connectionCenter.capabilityCount", { count: operations })
              }
            />
            {host.lastConnectedAt ? (
              <ConnectionRow
                icon={RefreshCwIcon}
                label={t("connectionCenter.lastConnected")}
                value={formatRelative(host.lastConnectedAt)}
              />
            ) : null}
          </dl>

          {host.connectionError ? (
            <>
              <Separator />
              <div
                className="flex items-start gap-2 p-3 text-xs"
                role="status"
                data-testid="driven-host-error"
              >
                <AlertCircleIcon
                  className="mt-0.5 size-3.5 shrink-0 text-destructive"
                  aria-hidden
                />
                <div className="min-w-0">
                  <p className="font-medium">{t("connectionCenter.lastError")}</p>
                  <p className="mt-0.5 line-clamp-2 break-words text-muted-foreground">
                    {host.connectionError}
                  </p>
                </div>
              </div>
            </>
          ) : null}

          <Separator />
          <div className="flex gap-2 p-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => {
                // Closed first: if a turn is in flight the guard's dialog takes
                // over, and a popover left open behind it is a stale question.
                setOpen(false)
                void requestSwitch(null)
              }}
              data-testid="driven-host-return-local"
            >
              <LaptopIcon aria-hidden />
              {t("connectionCenter.actions.returnLocal")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => {
                router.push(REMOTE_HOSTS_SETTINGS_HREF)
                setOpen(false)
              }}
              data-testid="driven-host-manage"
            >
              <SettingsIcon aria-hidden />
              {t("connectionCenter.actions.manageHosts")}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      {dialog}
    </>
  )
}

function RuntimeConnectivity({ platform }: { platform: ReturnType<typeof usePlatform> }) {
  const t = useTranslations("desktop.statusBar")
  const router = useRouter()
  const runtimeSnapshot = useRuntimeSnapshot()
  const requestOpenSettings = useUIStore((s) => s.requestOpenSettings)
  const { status } = useNetworkStatus()
  const connection = useConnectionState()
  const [open, setOpen] = useState(false)
  const [tier, setTier] = useState<TransportTier | null>(null)
  const [planeHealth, setPlaneHealth] = useState<CompanionPlaneHealth | null>(null)
  const [loadedHost, setLoadedHost] = useState<LoadedHostRecord | null>(null)
  // Three runtimes, not two. `target === null` means this shell IS the
  // execution host (Tauri/headless). A `standalone` target is the opposite: a
  // browser running what it can locally, with every host-backed operation
  // resolving to `requires-companion` (see `resolveOperationAvailability`).
  // Collapsing both into "not remote" is what painted a green, connected-
  // looking badge over a runtime that still has to pair before most of the app
  // works.
  //
  // Narrowed once into a local rather than re-derived per use: a `const`
  // boolean alias does not carry narrowing back to `runtimeSnapshot.target`,
  // so `remoteTarget ? runtimeSnapshot.target.hostKind : undefined` read
  // `hostKind` off a possibly-null union and never compiled.
  const target = runtimeSnapshot.target
  const companionTarget = target?.kind === "companion" ? target : null
  const remoteTarget = companionTarget !== null
  const nativeHost = !target
  const standaloneTarget = target?.kind === "standalone"
  const remoteHostKind = companionTarget?.hostKind
  const activeHostId = companionTarget?.id
  const hostRecord = loadedHost && loadedHost.hostId === activeHostId ? loadedHost.record : null

  // Local execution remains available when the internet is down. A remote Host
  // needs both device connectivity and a healthy runtime/transport state.
  const state: ConnState = !remoteTarget
    ? "online"
    : !status.connected ||
        connection === "offline" ||
        connection === "unauthenticated" ||
        runtimeSnapshot.connectionState === "offline"
      ? "offline"
      : connection === "reconnecting" || runtimeSnapshot.connectionState === "connecting"
        ? "reconnecting"
        : "online"

  const label =
    state === "offline"
      ? t("connOffline")
      : state === "reconnecting"
        ? t("connReconnecting")
        : t("connOnline")

  const triggerLabel = remoteTarget ? label : t("connectionCenter.localRuntime")
  const Icon = !remoteTarget
    ? LaptopIcon
    : state === "offline"
      ? WifiOffIcon
      : state === "reconnecting"
        ? RefreshCwIcon
        : WifiIcon

  const recoveryAvailability: OperationAvailability = nativeHost
    ? { state: "available", reason: "local-host" }
    : standaloneTarget
      ? { state: "unsupported", reason: "requires-companion" }
      : runtimeSnapshot.vaultState === "unavailable"
        ? { state: "requires-pairing", reason: "companion-not-paired" }
        : runtimeSnapshot.host && !runtimeSnapshot.host.compatible
          ? { state: "incompatible", reason: "host-protocol" }
          : state === "offline"
            ? { state: "offline", reason: "connection-offline" }
            : { state: "available", reason: "local-host" }
  const recovery = resolveRuntimeRecovery(recoveryAvailability, platform)

  useEffect(() => {
    if (!open || !remoteTarget) return
    const candidate = transport as unknown as {
      onTierChange?: (handler: (next: TransportTier) => void) => () => void
      getPlaneHealth?: () => CompanionPlaneHealth
      onPlaneHealthChange?: (handler: (next: CompanionPlaneHealth) => void) => () => void
    }
    const stopTier = candidate.onTierChange?.(setTier)
    // The current answer arrives through the same subscription path as later
    // changes: the callback reads it once on the next tick rather than the
    // effect body writing state synchronously.
    const stopHealth = candidate.onPlaneHealthChange?.(setPlaneHealth)
    const prime = window.setTimeout(() => setPlaneHealth(candidate.getPlaneHealth?.() ?? null), 0)
    return () => {
      window.clearTimeout(prime)
      stopTier?.()
      stopHealth?.()
    }
  }, [open, remoteTarget, runtimeSnapshot.target?.id])

  // The companion's own event plane in the Host's vocabulary (ADR-0170 batch
  // 4): `degraded` is the case a green link hides, where every request answers
  // and no event arrives, so changes made elsewhere never show up here.
  const eventPlane: EventPlaneState | null = !remoteTarget
    ? null
    : planeHealth === null
      ? null
      : planeHealth.events === "ready"
        ? "ready"
        : planeHealth.events === "replaying"
          ? "replaying"
          : planeHealth.events === "connecting"
            ? "connecting"
            : planeHealth.rpc === "ready"
              ? "degraded"
              : "disconnected"

  useEffect(() => {
    if (!open || !remoteTarget || !activeHostId) {
      return
    }
    const hostId = activeHostId
    const accountNamespace = activeAccountNamespace()
    if (!accountNamespace) return
    let cancelled = false
    void companionCredentialBook()
      .get({ accountNamespace, hostId })
      .then((record) => {
        if (!cancelled && record) setLoadedHost({ hostId, record })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [activeHostId, open, remoteTarget])

  const openRecovery = () => {
    if (recovery.kind === "route") {
      router.push(recovery.href)
      setOpen(false)
      return
    }
    if (recovery.kind === "local-settings") {
      requestOpenSettings("connectivity")
      setOpen(false)
    }
  }

  const reconnect = () => {
    const candidate = transport as unknown as {
      reconnectWs?: () => void
      reconnectRtc?: () => "ok" | "busy" | "no-tier" | "throttled"
    }
    candidate.reconnectWs?.()
    candidate.reconnectRtc?.()
  }

  const targetLabel = remoteTarget
    ? remoteHostKind === "desktop"
      ? t("connectionCenter.desktopHost")
      : t("connectionCenter.cloudHost")
    : platform === "tauri"
      ? t("connectionCenter.thisDesktop")
      : t("connectionCenter.thisBrowser")

  // Green is a claim that the runtime can serve. Only a native host or a live
  // Host link earns it; a standalone browser is a *mode*, not a connection, and
  // showing it in success green is what read as "already paired".
  const statusVariant = !remoteTarget
    ? nativeHost
      ? "success"
      : "secondary"
    : state === "offline"
      ? "destructive"
      : state === "reconnecting"
        ? "warning"
        : "success"

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={triggerLabel}
          title={triggerLabel}
          data-testid="status-connectivity"
          className="flex h-6 shrink-0 items-center gap-1 px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Icon
            aria-hidden
            className={cn(
              "size-3",
              remoteTarget && state === "reconnecting" && "animate-spin text-warning",
              remoteTarget && state === "offline" && "text-destructive",
              remoteTarget && state === "online" && "text-success"
            )}
          />
          <span className="hidden lg:inline">{triggerLabel}</span>
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" side="top" sideOffset={4} className="w-96 p-0">
        <PopoverHeader className="p-3">
          <div className="flex items-start gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
              {remoteTarget ? (
                remoteHostKind === "cloud" ? (
                  <CloudIcon className="size-4" aria-hidden />
                ) : (
                  <ServerIcon className="size-4" aria-hidden />
                )
              ) : (
                <LaptopIcon className="size-4" aria-hidden />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <PopoverTitle>{t("connectionCenter.title")}</PopoverTitle>
              <PopoverDescription className="truncate">
                {hostRecord?.label ?? targetLabel}
              </PopoverDescription>
            </div>
            <Badge variant={statusVariant} data-testid="connection-status-badge">
              {remoteTarget ? label : t("connectionCenter.localRuntime")}
            </Badge>
          </div>
        </PopoverHeader>

        <Separator />
        <dl className="flex flex-col gap-2 p-3 text-xs">
          <ConnectionRow
            icon={LaptopIcon}
            label={t("connectionCenter.runtimeTarget")}
            value={
              remoteTarget
                ? t("connectionCenter.remoteRuntime")
                : t("connectionCenter.localRuntime")
            }
          />
          <ConnectionRow
            icon={status.connected ? WifiIcon : WifiOffIcon}
            label={t("connectionCenter.network")}
            value={t(
              `connectionCenter.networkType.${status.connected ? status.connectionType : "none"}`
            )}
          />
          {remoteTarget ? (
            <>
              <ConnectionRow
                icon={ServerIcon}
                label={t("connectionCenter.hostLink")}
                value={label}
              />
              <ConnectionRow
                icon={RefreshCwIcon}
                label={t("connectionCenter.transport")}
                value={t(`connectionCenter.tier.${tier ?? "unknown"}`)}
              />
              {eventPlane ? (
                <ConnectionRow
                  icon={ActivityIcon}
                  label={t("connectionCenter.eventPlane")}
                  value={t(`connectionCenter.eventPlaneState.${eventPlane}`)}
                  title={
                    eventPlane === "degraded"
                      ? t("connectionCenter.eventPlaneDegradedHint")
                      : undefined
                  }
                />
              ) : null}
              {hostRecord ? (
                <ConnectionRow
                  icon={LinkIcon}
                  label={t("connectionCenter.address")}
                  value={hostRecord.endpoints.baseUrl}
                  title={hostRecord.endpoints.baseUrl}
                />
              ) : null}
              {hostRecord?.serverVersion ? (
                <ConnectionRow
                  icon={ServerIcon}
                  label={t("connectionCenter.serverVersion")}
                  value={hostRecord.serverVersion}
                />
              ) : null}
              <ConnectionRow
                icon={KeyRoundIcon}
                label={t("connectionCenter.authentication")}
                value={t(`connectionCenter.auth.${runtimeSnapshot.vaultState}`)}
              />
              <ConnectionRow
                icon={ShieldCheckIcon}
                label={t("connectionCenter.protocol")}
                value={t(
                  `connectionCenter.protocolStatus.${
                    runtimeSnapshot.host
                      ? runtimeSnapshot.host.compatible
                        ? "compatible"
                        : "incompatible"
                      : "checking"
                  }`
                )}
              />
              <ConnectionRow
                icon={ActivityIcon}
                label={t("connectionCenter.capabilities")}
                value={t("connectionCenter.capabilityCount", {
                  count: runtimeSnapshot.host?.operations.length ?? 0,
                })}
              />
              {hostRecord?.connection.lastOkAt ? (
                <ConnectionRow
                  icon={RefreshCwIcon}
                  label={t("connectionCenter.lastConnected")}
                  value={formatRelative(hostRecord.connection.lastOkAt)}
                />
              ) : null}
            </>
          ) : null}
        </dl>

        {standaloneTarget ? (
          <>
            <Separator />
            <div className="flex items-start gap-2 p-3 text-xs" data-testid="standalone-scope-note">
              <ServerIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <p className="min-w-0 text-muted-foreground">
                {t("connectionCenter.standaloneScope")}
              </p>
            </div>
          </>
        ) : null}

        {hostRecord?.connection.lastError ? (
          <>
            <Separator />
            <div className="flex items-start gap-2 p-3 text-xs" role="status">
              <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
              <div className="min-w-0">
                <p className="font-medium">{t("connectionCenter.lastError")}</p>
                <p className="mt-0.5 line-clamp-2 break-words text-muted-foreground">
                  {hostRecord.connection.lastError}
                </p>
              </div>
            </div>
          </>
        ) : null}

        {/* Also rendered on the standalone target, which is the case that
          needed it most: the footer's only action there is "Connect Host",
          so a browser that had already paired was being told to pair again
          with no way to pick the Host it owns. The section self-hides unless
          a companion target exists, so a never-paired browser is unchanged. */}
        {platform === "web" ? (
          <RuntimeTargetMenuSection
            requireCompanion
            showAddHost={false}
            className="border-t p-1"
            onSwitched={() => setOpen(false)}
          />
        ) : null}

        <Separator />
        <div className="flex gap-2 p-2">
          {remoteTarget ? (
            <Button variant="outline" size="sm" className="flex-1" onClick={reconnect}>
              <RefreshCwIcon aria-hidden />
              {t("connectionCenter.actions.reconnect")}
            </Button>
          ) : platform === "web" ? (
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => {
                router.push("/pair?mode=add")
                setOpen(false)
              }}
            >
              <ServerIcon aria-hidden />
              {t("connectionCenter.actions.connectHost")}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => {
                requestOpenSettings("connectivity")
                setOpen(false)
              }}
            >
              <SettingsIcon aria-hidden />
              {t("connectionCenter.actions.settings")}
            </Button>
          )}
          {recovery.kind !== "none" && remoteTarget ? (
            <Button size="sm" className="flex-1" onClick={openRecovery}>
              {t("connectionCenter.actions.recover")}
            </Button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ConnectionRow({
  icon: Icon,
  label,
  value,
  title,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>
  label: string
  value: string
  title?: string
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="ml-auto max-w-[60%] truncate text-right font-medium" title={title}>
        {value}
      </dd>
    </div>
  )
}
