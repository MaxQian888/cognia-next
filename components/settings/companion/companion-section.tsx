"use client"

/**
 * Desktop-side Companion control plane: HTTPS server/tunnel state, canonical
 * cgnp3 Owner invitations, paired-device capability snapshots and revocation,
 * signaling/WebRTC diagnostics, OIDC configuration, and push credentials.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronDownIcon,
  CircleIcon,
  CheckIcon,
  QrCodeIcon,
  ShieldAlertIcon,
  SmartphoneIcon,
} from "lucide-react"
import { QRCodeSVG } from "qrcode.react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { isTauri, transport } from "@/lib/tauri"
import { startBroadcast, stopBroadcast, type TauriInvoker } from "@/lib/connectivity/mdns-discovery"
import {
  loadReachabilityPrefs,
  patchReachabilityPrefs,
} from "@/lib/connectivity/reachability-prefs"
import { saveNamedTunnelConfig } from "@/lib/connectivity/tunnel-resolver"
import { useLiveQuery } from "dexie-react-hooks"

import { listPairedDevices } from "@/lib/db/paired-devices"
import { encodePairPayload } from "@/lib/qr/pair-payload"
import { cn } from "@/lib/utils"
import { APP_VERSION } from "@/lib/app-version"
import { useAccountStore } from "@/stores/account/account-store"
import { ChannelMatrixCard } from "./channel-matrix-card"
import { DeviceConsoleLink } from "@/components/devices/device-console-link"
import { WebRtcCard } from "./webrtc-card"
import { SyncStatusCard } from "./sync-status-card"
import { LogtoLoginCard } from "./logto-login-card"
import { CollaborationCard } from "./collaboration-card"
import { RemoteBrowserCard } from "./remote-browser-card"
import { WorkspaceRootsCard } from "./workspace-roots-card"
import { BrowserAccessCard } from "./browser-access-card"
import { BrowserCompanionCard } from "./browser-companion-card"

// ---------------------------------------------------------------------------
// Tauri command shapes — mirror src-tauri/src/companion_api/commands.rs
// ---------------------------------------------------------------------------

// Mirrors Rust `companion_api::server::DEFAULT_PORT` — 27890, outside the
// 789x Clash mixed/SOCKS range so it can't collide with a local proxy.
const DEFAULT_PORT = 27890

type BindMode = "loopback" | "lan"

interface CompanionServerStatus {
  running: boolean
  bindMode: "loopback" | "lan" | "none"
  boundPort: number | null
}

interface OwnerInvitationIssue {
  invitation: string
  expiresAtMs: number
  baseUrl: string
  /** SHA-256 SubjectPublicKeyInfo fingerprint (Wave 1.4). Empty if absent. */
  fingerprint?: string
  /** Server app version (Wave 1.7 v2 payload). */
  appVersion?: string
  hostId: string
  tenantId: string
}

interface TunnelInfo {
  publicUrl: string
  localUrl: string
}

async function fetchStatus(): Promise<CompanionServerStatus> {
  if (!isTauri()) {
    return { running: false, bindMode: "none", boundPort: null }
  }
  return transport.call<CompanionServerStatus>("companion_server_status")
}

async function startServer(bindMode: BindMode): Promise<number> {
  const port = await transport.call<number>("companion_server_start", {
    port: DEFAULT_PORT,
    bindLoopbackOnly: bindMode === "loopback",
  })
  // The three elevated grants live in the host's SecurityStore, which is
  // persistent — nothing to re-project at boot. All that is left is the
  // one-time import of the pre-migration Dexie flags, so an upgrading user
  // does not silently lose grants they had already made.
  await migrateLegacyDeviceGrants()
  await seedLockedComputerUseAllowList()
  return port
}

/**
 * Import the legacy Dexie grant flags into the host's SecurityStore, once.
 *
 * Deliberately not a per-boot reseed. The store is the authority now, so
 * re-projecting Dexie on every launch would let a stale mirror row resurrect a
 * grant that was revoked through the store (the `cognia-server devices` CLI,
 * the owner API) — the exact revocation-doesn't-stick bug the old replace
 * semantics were guarding against, just in the other direction. Rust guards the
 * import behind a committed marker, so this is a no-op after the first run.
 *
 * Best-effort: a failure here leaves the store's own grants untouched.
 */
async function migrateLegacyDeviceGrants(): Promise<void> {
  if (!isTauri()) return
  try {
    const devices = await listPairedDevices()
    const live = devices.filter((d) => d.revokedAt === undefined)
    // Each grant comes from its own column, never derived from another: they
    // are independent, and inferring one from the other would quietly widen
    // whichever the user actually chose.
    await transport.call<boolean>("companion_migrate_legacy_device_grants", {
      control: live.filter((d) => d.allowRemoteControl === true).map((d) => d.deviceId),
      agentControl: live.filter((d) => d.allowAgentControl === true).map((d) => d.deviceId),
      terminal: live.filter((d) => d.allowRemoteTerminal === true).map((d) => d.deviceId),
    })
  } catch (err) {
    console.warn("migrateLegacyDeviceGrants failed", err)
  }
}

/**
 * Locked Use keeps its per-boot reseed: unlike the three grants above, its list
 * is in-memory and intentionally dormant, so Dexie is still its only truth.
 * See `src-tauri/src/companion_api/locked_use_allow_list.rs`.
 */
async function seedLockedComputerUseAllowList(): Promise<void> {
  if (!isTauri()) return
  try {
    const devices = await listPairedDevices()
    const allowed = devices
      .filter(
        (device) =>
          device.allowRemoteControl === true &&
          device.allowLockedComputerUse === true &&
          device.revokedAt === undefined
      )
      .map((device) => device.deviceId)
    await transport.call<void>("companion_seed_locked_computer_use", { deviceIds: allowed })
  } catch (err) {
    console.warn("seedLockedComputerUseAllowList failed", err)
  }
}

async function stopServer(): Promise<void> {
  await transport.call<void>("companion_server_stop")
}

/**
 * Takes no arguments on purpose.
 *
 * This used to pass `localAccountId`, which the Rust command accepted and then
 * ignored in favour of a hardcoded tenant — so the argument described a
 * relationship that did not exist. The tenant now comes from the host binding
 * that a verified unlock establishes, which is why the caller still refuses to
 * generate a QR while the account is locked.
 */
/**
 * The `lib/connectivity` wrappers take an invoker so they stay testable off
 * Tauri. Handing them the companion transport keeps this section on the same
 * routed call every other control here uses, instead of the second copy of
 * each `companion_mdns_*` / `companion_tunnel_*` call that used to live here.
 */
const transportInvoker = async (): Promise<TauriInvoker> => ({
  // Arity matters to the transport spies: `call(name, undefined)` is not
  // `call(name)`, so an argument-less command is forwarded argument-less.
  invoke: <T = unknown,>(cmd: string, args?: Record<string, unknown>) =>
    args === undefined ? transport.call<T>(cmd) : transport.call<T>(cmd, args),
})

async function createOwnerInvitation(): Promise<OwnerInvitationIssue> {
  return transport.call<OwnerInvitationIssue>("companion_create_owner_invitation")
}

async function getMdnsStatus(): Promise<boolean> {
  if (!isTauri()) return false
  return transport.call<boolean>("companion_mdns_status")
}

async function startTunnel(localUrl: string): Promise<TunnelInfo> {
  return transport.call<TunnelInfo>("companion_tunnel_start", { localUrl })
}

async function stopTunnel(): Promise<void> {
  await transport.call<void>("companion_tunnel_stop")
}

async function getTunnelInfo(): Promise<TunnelInfo | null> {
  if (!isTauri()) return null
  return transport.call<TunnelInfo | null>("companion_tunnel_current")
}

async function getTunnelConfig(): Promise<{
  mode: "quick" | "named"
  hostname?: string
  hasToken: boolean
} | null> {
  if (!isTauri()) return null
  return transport.call<{ mode: "quick" | "named"; hostname?: string; hasToken: boolean }>(
    "companion_tunnel_get_config"
  )
}

async function setTunnelMode(mode: "quick" | "named"): Promise<void> {
  return transport.call<void>("companion_tunnel_set_mode", { mode })
}

async function clearNamedConfig(): Promise<void> {
  return transport.call<void>("companion_tunnel_clear_named")
}

// ---------------------------------------------------------------------------
// Top-level section
// ---------------------------------------------------------------------------

export function CompanionSection() {
  const t = useTranslations("mobile.companion.groups")
  return (
    <div className="space-y-3 p-4" data-testid="companion-section">
      <CompanionGroup id="network" title={t("network")} defaultOpen>
        {/* First, because it is the question the four cards below only answer
            between them: which routes does this desktop actually answer on. */}
        <ChannelMatrixCard />
        <ServerStatusCard />
        <TunnelCard />
        <MdnsCard />
        {/* Beside the other reachability cards, not under "cloud": this is how
            a browser on THIS machine reaches the Host, and it is the only door
            a tab has — the HTTPS listener above is unreachable from one. */}
        <BrowserAccessCard />
        <WebRtcCard />
      </CompanionGroup>
      <CompanionGroup id="pairing" title={t("pairing")} defaultOpen>
        <PairDeviceCard />
        {/* Under pairing, not under reachability: this mints a one-shot
            credential, which is a pairing act. Browser Access above is the
            transport switch it depends on. */}
        <BrowserCompanionCard />
        <PairedDevicesSummary />
        {/* Under pairing because it answers a question only a paired
            client asks: now that I am connected, which folders may I open?
            Read-only, since a headless Host takes its root from the
            environment it was started with and no client may widen it. */}
        <WorkspaceRootsCard />
      </CompanionGroup>
      <CompanionGroup id="cloud" title={t("cloud")} defaultOpen={false}>
        <RemoteBrowserCard />
        <LogtoLoginCard />
        {/* Below sign-in on purpose: the plane needs the person before it
            needs the address, and a card that asks for a URL first invites
            configuring a server nothing can authenticate to. */}
        <CollaborationCard />
      </CompanionGroup>
      <CompanionGroup id="push" title={t("push")} defaultOpen>
        <PushCredentialsCard />
      </CompanionGroup>
      {/* Per-table sync state is a power-user surface; collapsed by default so
          the common pairing / push path isn't buried. The reachability probe
          that used to live here moved into the channel matrix above, where its
          results are attributed to a channel instead of printed as a flat list
          of URLs. */}
      <CompanionGroup id="advanced" title={t("advanced")} defaultOpen={false}>
        <SyncStatusCard />
      </CompanionGroup>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Collapsible group wrapper — labeled section header + chevron. Inlined here
// (not its own file) so it rides the existing companion-section.test.tsx
// coverage; its only behavior is open/close, exercised by the section tests.
// ---------------------------------------------------------------------------

/**
 * What is left of the paired-devices table here: a count and a way in.
 *
 * The table itself moved to `/devices`, where a device is more than a row —
 * capabilities, live presence, the capabilities behind each grant. Keeping a
 * second list here would mean two surfaces to hold in step, and the one in
 * Settings would be the one that fell behind.
 */
function PairedDevicesSummary() {
  const devices = useLiveQuery(() => listPairedDevices(), [], [])
  return <DeviceConsoleLink surface="paired" count={devices?.length ?? 0} />
}

function CompanionGroup({
  id,
  title,
  defaultOpen = true,
  children,
}: {
  id: string
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-lg border bg-muted/30"
      data-testid={`companion-group-${id}`}
    >
      <CollapsibleTrigger
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-sm font-semibold"
        data-testid={`companion-group-trigger-${id}`}
      >
        <span>{title}</span>
        <ChevronDownIcon
          aria-hidden="true"
          className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 px-2 pb-3">{children}</CollapsibleContent>
    </Collapsible>
  )
}

// ---------------------------------------------------------------------------
// Tunnel card (Wave 1.6) — Cloudflared launcher
// ---------------------------------------------------------------------------

function TunnelCard() {
  const t = useTranslations("mobile.companion.tunnel")
  const desktop = isTauri()
  const [info, setInfo] = useState<TunnelInfo | null>(null)
  const [config, setConfig] = useState<{
    mode: "quick" | "named"
    hostname?: string
    hasToken: boolean
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [hostnameInput, setHostnameInput] = useState("")
  const [tokenInput, setTokenInput] = useState("")

  useEffect(() => {
    let cancelled = false
    void Promise.all([getTunnelInfo(), getTunnelConfig()])
      .then(([current, cfg]) => {
        if (!cancelled) {
          setInfo(current)
          setConfig(cfg)
          if (cfg?.hostname) setHostnameInput(cfg.hostname)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const onToggle = useCallback(
    async (enabled: boolean) => {
      if (!desktop) {
        toast.error(t("onlyDesktop"))
        return
      }
      setBusy(true)
      try {
        if (enabled) {
          const next = await startTunnel(`https://127.0.0.1:${DEFAULT_PORT}`)
          setInfo(next)
          toast.success(t("started"))
        } else {
          await stopTunnel()
          setInfo(null)
          toast.success(t("stopped"))
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/cloudflared.*not.found|not.installed/i.test(msg)) {
          toast.error(t("notInstalled"))
        } else {
          toast.error(msg)
        }
      } finally {
        setBusy(false)
      }
    },
    [desktop, t]
  )

  const onModeChange = useCallback(
    async (mode: "quick" | "named") => {
      if (!desktop) return
      setBusy(true)
      try {
        await setTunnelMode(mode)
        const next = await getTunnelConfig()
        setConfig(next)
        if (next?.hostname) setHostnameInput(next.hostname)
        if (mode === "quick") {
          await stopTunnel()
          setInfo(null)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast.error(msg)
      } finally {
        setBusy(false)
      }
    },
    [desktop]
  )

  const onSaveNamed = useCallback(async () => {
    if (!desktop || !hostnameInput.trim() || !tokenInput.trim()) return
    setSaving(true)
    try {
      const saved = await saveNamedTunnelConfig(
        tokenInput.trim(),
        hostnameInput.trim(),
        transportInvoker
      )
      if (saved.kind === "error") throw new Error(saved.message)
      const next = await getTunnelConfig()
      setConfig(next)
      // The token is a write-only secret — never read back into the field.
      // Clear it on success so a populated password box doesn't imply the
      // field still "holds" the saved value; the "Token configured" badge
      // (driven by `hasToken`) is the source of truth instead.
      setTokenInput("")
      toast.success(t("saved"))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(msg)
    } finally {
      setSaving(false)
    }
  }, [desktop, hostnameInput, tokenInput, t])

  const onClearNamed = useCallback(async () => {
    if (!desktop) return
    setBusy(true)
    try {
      await clearNamedConfig()
      const next = await getTunnelConfig()
      setConfig(next)
      setHostnameInput("")
      setTokenInput("")
      setInfo(null)
      toast.success(t("cleared"))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(msg)
    } finally {
      setBusy(false)
    }
  }, [desktop, t])

  const mode = config?.mode ?? "quick"
  const namedReady = config?.hasToken && config?.hostname

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-2 text-sm font-medium">
          <span className="flex items-center gap-2">{t("title")}</span>
        </CardTitle>
        <CardDescription className="text-xs">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-xs text-muted-foreground">
        <RadioGroup
          value={mode}
          onValueChange={(v) => void onModeChange(v as "quick" | "named")}
          className="flex gap-4"
          disabled={!desktop || busy}
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem value="quick" id="tunnel-mode-quick" disabled={!desktop || busy} />
            <Label htmlFor="tunnel-mode-quick" className="text-xs font-normal">
              {t("modeQuick")}
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="named" id="tunnel-mode-named" disabled={!desktop || busy} />
            <Label htmlFor="tunnel-mode-named" className="text-xs font-normal">
              {t("modeNamed")}
            </Label>
          </div>
        </RadioGroup>

        {mode === "quick" && (
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 break-all">{info ? info.publicUrl : t("off")}</span>
            <Switch
              checked={!!info}
              onCheckedChange={onToggle}
              disabled={!desktop || busy}
              aria-label={t("enableLabel")}
            />
          </div>
        )}

        {mode === "named" && (
          <div className="space-y-2">
            {/* 统一行：状态/hostname/off + Switch（未配置时禁用） */}
            <div className="flex items-center justify-between gap-2">
              <span className="break-all">
                {info ? info.publicUrl : namedReady ? config!.hostname : t("off")}
              </span>
              <Switch
                checked={!!info}
                onCheckedChange={onToggle}
                disabled={!desktop || busy || !namedReady}
                aria-label={t("enableLabel")}
              />
            </div>
            {/* 配置表单始终可见 */}
            <div className="space-y-1">
              <Label htmlFor="tunnel-hostname" className="text-xs">
                {t("hostnameLabel")}
              </Label>
              <Input
                id="tunnel-hostname"
                type="url"
                placeholder={t("hostnamePlaceholder")}
                value={hostnameInput}
                onChange={(e) => setHostnameInput(e.target.value)}
                disabled={!desktop || saving}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tunnel-token" className="text-xs">
                {t("tokenLabel")}
              </Label>
              <Input
                id="tunnel-token"
                type="password"
                placeholder={t("tokenPlaceholder")}
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                disabled={!desktop || saving}
                className="h-8 text-xs"
              />
            </div>
            {namedReady && (
              <Badge
                variant="outline"
                className="w-fit gap-1 text-[10px] uppercase text-emerald-600 dark:text-emerald-400"
                data-testid="tunnel-token-configured"
              >
                <CheckIcon className="size-3" aria-hidden="true" />
                {t("tokenConfigured")}
              </Badge>
            )}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => void onSaveNamed()}
                disabled={!desktop || saving || !hostnameInput.trim() || !tokenInput.trim()}
                className="flex-1"
              >
                {saving ? t("saving") : t("saveButton")}
              </Button>
              {namedReady && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void onClearNamed()}
                  disabled={busy || saving}
                  aria-label={t("clearAria")}
                >
                  {t("clearButton")}
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// mDNS card (Wave 1.5) — LAN broadcast toggle
// ---------------------------------------------------------------------------

function MdnsCard() {
  const t = useTranslations("mobile.companion.mdns")
  const desktop = isTauri()
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  // The saved boot preference, read separately from the live status. The
  // switch shows what is running; this is what was asked for. They disagree
  // exactly when the boot restore failed, and that used to be invisible: the
  // switch simply read "off" over a preference that said "on".
  const [wanted, setWanted] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    void getMdnsStatus()
      .then((s) => {
        if (!cancelled) setRunning(s)
      })
      .catch(() => {})
    if (desktop) {
      void loadReachabilityPrefs()
        .then((prefs) => {
          if (!cancelled) setWanted(prefs.mdnsEnabled)
        })
        .catch(() => {})
    }
    return () => {
      cancelled = true
    }
  }, [desktop])
  const autostartFailed = wanted === true && !running && !busy

  const onToggle = useCallback(
    async (enabled: boolean) => {
      if (!desktop) {
        toast.error(t("onlyDesktop"))
        return
      }
      setBusy(true)
      try {
        if (enabled) {
          const fingerprint = await transport
            .call<string>("companion_get_tls_fingerprint")
            .catch(() => "")
          const started = await startBroadcast(
            {
              port: DEFAULT_PORT,
              appVersion: APP_VERSION,
              tlsFingerprint: fingerprint,
            },
            transportInvoker
          )
          if (started.kind === "error") throw new Error(started.message)
          if (started.kind === "unsupported") throw new Error(t("onlyDesktop"))
          setRunning(true)
          setWanted(true)
          toast.success(t("started"))
        } else {
          await stopBroadcast(transportInvoker)
          setRunning(false)
          setWanted(false)
          toast.success(t("stopped"))
        }
        // Remember the choice so the boot restore re-advertises. Without this
        // the broadcast dies with the process and the phone that paired over
        // the LAN silently loses discovery on the next restart.
        await patchReachabilityPrefs({ mdnsEnabled: enabled })
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [desktop, t]
  )

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-2 text-sm font-medium">
          <span>{t("title")}</span>
          <Switch
            checked={running}
            onCheckedChange={onToggle}
            disabled={!desktop || busy}
            aria-label={t("enableLabel")}
          />
        </CardTitle>
        <CardDescription className="text-xs">{t("description")}</CardDescription>
      </CardHeader>
      {autostartFailed ? (
        <CardContent className="pt-0">
          <p
            role="status"
            className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300"
            data-testid="mdns-autostart-failed"
          >
            <ShieldAlertIcon className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{t("autostartFailed")}</span>
          </p>
        </CardContent>
      ) : null}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Card 1 — server status + master toggle + bind-mode radio
// ---------------------------------------------------------------------------

function ServerStatusCard() {
  const t = useTranslations("mobile.companion.server")
  const desktop = isTauri()
  const [status, setStatus] = useState<CompanionServerStatus>({
    running: false,
    bindMode: "none",
    boundPort: null,
  })
  // The radio reflects the user's *desired* binding. When the server is
  // stopped, `status.bindMode === "none"` so we keep this independently so
  // the toggle-on path knows what to start with.
  const [desiredBind, setDesiredBind] = useState<BindMode>("loopback")
  const [busy, setBusy] = useState(false)
  // The saved boot preference, next to the live status. The switch shows what
  // is running, this is what was asked for, and the two disagree exactly when
  // the boot restore failed. That case used to be a switch reading "off".
  const [wanted, setWanted] = useState<boolean | null>(null)
  // Where the TLS material lives. A user installing the CA on a phone, or
  // rotating the cert, needs the path. The command that answers it existed
  // and nothing called it.
  const [tlsPaths, setTlsPaths] = useState<CompanionTlsPaths | null>(null)

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    void loadReachabilityPrefs()
      .then((prefs) => {
        if (!cancelled) setWanted(prefs.serverEnabled)
      })
      .catch(() => {})
    void transport
      .call<CompanionTlsPaths>("companion_tls_paths")
      .then((paths) => {
        if (!cancelled && paths && typeof paths.certPemPath === "string") setTlsPaths(paths)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [desktop])

  // Live status — refresh every 3 s while mounted, plus an immediate fetch
  // on mount so the initial UI doesn't flicker through "stopped" when the
  // server is already running (e.g., user navigated away and back).
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const next = await fetchStatus()
        if (!cancelled) {
          setStatus(next)
          if (next.bindMode === "loopback" || next.bindMode === "lan") {
            setDesiredBind(next.bindMode)
          }
        }
      } catch {
        // swallow — desktop not ready / web mode
      }
      if (!cancelled) timer = setTimeout(refresh, 3000)
    }
    void refresh()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  const onToggleEnabled = useCallback(
    async (enabled: boolean) => {
      if (!desktop) {
        toast.error(t("desktopOnlyError"))
        return
      }
      setBusy(true)
      try {
        if (enabled) {
          const port = await startServer(desiredBind)
          setStatus({
            running: true,
            bindMode: desiredBind,
            boundPort: port,
          })
          setWanted(true)
          toast.success(t("started", { port }))
          // This switch is the user's intent surface for "be reachable", so it
          // is one of the few places allowed to write the boot preference —
          // internal starts (the fleet monitor's loopback ingress) deliberately
          // do not, or they would downgrade a saved LAN binding.
          await patchReachabilityPrefs({
            serverEnabled: true,
            port,
            bindLoopbackOnly: desiredBind === "loopback",
          })
        } else {
          await stopServer()
          setStatus({ running: false, bindMode: "none", boundPort: null })
          setWanted(false)
          toast.success(t("stopped"))
          await patchReachabilityPrefs({ serverEnabled: false })
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [desktop, desiredBind, t]
  )

  // Switching the radio while the server is running rebinds — stop + start.
  const onBindModeChange = useCallback(
    async (next: string) => {
      const mode = next as BindMode
      setDesiredBind(mode)
      if (!desktop) return
      // Persist before the running-check: the radio is the desired binding
      // whether or not the server is up right now, and a user who picks LAN
      // while stopped then enables at boot must not come back on loopback.
      await patchReachabilityPrefs({ bindLoopbackOnly: mode === "loopback" })
      if (!status.running) return
      setBusy(true)
      try {
        await stopServer()
        const port = await startServer(mode)
        setStatus({ running: true, bindMode: mode, boundPort: port })
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [desktop, status.running]
  )

  const lanWarning = status.running && status.bindMode === "lan"
  const autostartFailed = wanted === true && !status.running && !busy

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-2 text-sm font-medium">
          <span className="flex items-center gap-2">
            <SmartphoneIcon className="h-4 w-4" />
            {t("title")}
            <StatusBadge status={status} desktop={desktop} t={t} />
          </span>
          <Switch
            checked={status.running}
            onCheckedChange={onToggleEnabled}
            disabled={!desktop || busy}
            aria-label={t("enableLabel")}
          />
        </CardTitle>
        <CardDescription className="text-xs">
          {status.running && status.boundPort !== null
            ? t("listeningOn", {
                url: `http://${
                  status.bindMode === "lan" ? t("bindModePlaceholderLan") : "127.0.0.1"
                }:${status.boundPort}`,
              })
            : t("serverOff")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div>
          <Label className="mb-2 block text-xs text-muted-foreground">{t("bindMode")}</Label>
          <RadioGroup
            value={desiredBind}
            onValueChange={onBindModeChange}
            className="space-y-2"
            aria-label={t("bindMode")}
          >
            <div className="flex items-start gap-3 rounded border bg-card px-3 py-2">
              <RadioGroupItem value="loopback" id="bind-loopback" disabled={!desktop || busy} />
              <div className="space-y-0.5">
                <Label htmlFor="bind-loopback" className="text-sm font-medium">
                  {t("loopbackLabel")}
                </Label>
                <p className="text-xs text-muted-foreground">{t("loopbackDesc")}</p>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded border bg-card px-3 py-2">
              <RadioGroupItem value="lan" id="bind-lan" disabled={!desktop || busy} />
              <div className="space-y-0.5">
                <Label htmlFor="bind-lan" className="text-sm font-medium">
                  {t("lanLabel")}
                </Label>
                <p className="text-xs text-muted-foreground">{t("lanDesc")}</p>
              </div>
            </div>
          </RadioGroup>
        </div>
        {lanWarning && (
          <div
            role="status"
            className="flex items-start gap-2 rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300"
          >
            <ShieldAlertIcon className="h-3.5 w-3.5 shrink-0" />
            <span>{t("httpsWarning")}</span>
          </div>
        )}
        {autostartFailed && (
          <p
            role="status"
            className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300"
            data-testid="server-autostart-failed"
          >
            <ShieldAlertIcon className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{t("autostartFailed")}</span>
          </p>
        )}
        {tlsPaths && (
          <dl className="space-y-1 text-xs text-muted-foreground" data-testid="server-tls-paths">
            <div className="flex flex-col gap-0.5">
              <dt>{t("certificateFile")}</dt>
              <dd className="break-all font-mono text-[11px] text-foreground/80">
                {tlsPaths.certPemPath}
              </dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt>{t("certificateFingerprint")}</dt>
              <dd className="break-all font-mono text-[11px] text-foreground/80">
                {tlsPaths.fingerprintSha256}
              </dd>
            </div>
          </dl>
        )}
        {!desktop && <p className="text-xs text-muted-foreground">{t("desktopOnly")}</p>}
      </CardContent>
    </Card>
  )
}

/** Mirror of the Rust `CompanionTlsPaths` (`companion_api/commands.rs`). */
interface CompanionTlsPaths {
  certPemPath: string
  keyPemPath: string
  fingerprintSha256: string
}

function StatusBadge({
  status,
  desktop,
  t,
}: {
  status: CompanionServerStatus
  desktop: boolean
  t: (key: string) => string
}) {
  if (!desktop) {
    return (
      <span className="text-[10px] uppercase text-muted-foreground" title={t("desktopOnly")}>
        {t("statusWeb")}
      </span>
    )
  }
  return status.running ? (
    <span className="flex items-center gap-1 text-[10px] uppercase text-emerald-500">
      <CircleIcon className="h-2 w-2 fill-current" />
      {t("statusLive")}
    </span>
  ) : (
    <span className="flex items-center gap-1 text-[10px] uppercase text-muted-foreground">
      <CircleIcon className="h-2 w-2 fill-current" />
      {t("statusIdle")}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Card 2 — Pair a new device (QR + countdown)
// ---------------------------------------------------------------------------

function PairDeviceCard() {
  const t = useTranslations("mobile.companion.pair")
  const desktop = isTauri()
  const localAccountId = useAccountStore((state) => state.unlockedAccountId)
  const [issue, setIssue] = useState<OwnerInvitationIssue | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState<number>(() => Date.now())

  // Drive the countdown — re-render once a second while a pairing JWT is
  // active. Stops once the timer expires to avoid a wasted interval.
  useEffect(() => {
    if (!issue) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [issue])

  const onGenerate = useCallback(async () => {
    if (!desktop) {
      toast.error(t("desktopOnlyError"))
      return
    }
    if (!localAccountId) {
      toast.error(t("accountLocked"))
      return
    }
    setBusy(true)
    try {
      const next = await createOwnerInvitation()
      setIssue(next)
      setNow(Date.now())
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [desktop, localAccountId, t])

  const expired = issue ? now >= issue.expiresAtMs : false
  const remainingSecs = issue ? Math.max(0, Math.floor((issue.expiresAtMs - now) / 1000)) : 0

  // QR payload cgnp3 carries only the one-shot invitation and discovery
  // metadata. Long-lived device credentials are created on the client and
  // never embedded in this offline payload.
  const qrPayload = useMemo(() => {
    if (!issue) return null
    return encodePairPayload({
      baseUrl: issue.baseUrl,
      mode: "owner-invitation",
      invitation: issue.invitation,
      hostId: issue.hostId,
      tenantId: issue.tenantId,
      expiresAt: issue.expiresAtMs,
      serverVersion: issue.appVersion ?? APP_VERSION,
      fingerprint: issue.fingerprint ?? "",
    })
  }, [issue])

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <QrCodeIcon className="h-4 w-4" />
          {t("title")}
        </CardTitle>
        <CardDescription className="text-xs">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={onGenerate}
            disabled={!desktop || busy}
            aria-label={t("generateAria")}
          >
            <QrCodeIcon className="mr-1 h-3.5 w-3.5" />
            {issue ? t("refreshQr") : t("generateQr")}
          </Button>
          {issue && (
            <span
              className={cn("text-xs", expired ? "text-destructive" : "text-muted-foreground")}
              aria-live="polite"
            >
              {expired ? t("expired") : t("expiresIn", { time: formatRemaining(remainingSecs) })}
            </span>
          )}
        </div>
        {issue && qrPayload && !expired && (
          <div
            className="flex w-full justify-center rounded border bg-card p-4"
            data-testid="pair-qr-canvas"
          >
            <QRCodeSVG value={qrPayload} size={224} level="M" aria-label={t("qrAria")} />
          </div>
        )}
        {issue && (
          <p className="break-all text-[10px] font-mono text-muted-foreground">{issue.baseUrl}</p>
        )}
      </CardContent>
    </Card>
  )
}

function formatRemaining(secs: number): string {
  const mm = Math.floor(secs / 60)
    .toString()
    .padStart(2, "0")
  const ss = (secs % 60).toString().padStart(2, "0")
  return `${mm}:${ss}`
}

// ---------------------------------------------------------------------------
// Reachability diagnostics card (Phase C2)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Push credentials card (Phase B follow-up)
// ---------------------------------------------------------------------------

interface PushConfigStatus {
  fcmConfigured: boolean
  apnsConfigured: boolean
}

async function fetchPushStatus(): Promise<PushConfigStatus> {
  if (!isTauri()) return { fcmConfigured: false, apnsConfigured: false }
  return transport.call<PushConfigStatus>("companion_push_status")
}

async function configureFcm(serviceAccountJson: string): Promise<void> {
  await transport.call<void>("companion_push_configure_fcm", { serviceAccountJson })
}

async function clearFcm(): Promise<void> {
  await transport.call<void>("companion_push_clear_fcm")
}

async function configureApns(args: {
  keyId: string
  teamId: string
  bundleId: string
  privateKeyPem: string
  production: boolean
}): Promise<void> {
  await transport.call<void>("companion_push_configure_apns", args)
}

async function clearApns(): Promise<void> {
  await transport.call<void>("companion_push_clear_apns")
}

function PushCredentialsCard() {
  const t = useTranslations("mobile.companion.push")
  const desktop = isTauri()
  const [status, setStatus] = useState<PushConfigStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [fcmJson, setFcmJson] = useState("")
  const [apns, setApns] = useState({
    keyId: "",
    teamId: "",
    bundleId: "com.cognia.mobile",
    privateKeyPem: "",
    production: false,
  })

  const refresh = useCallback(async () => {
    if (!desktop) return
    try {
      const s = await fetchPushStatus()
      setStatus(s)
    } catch (err) {
      toast.error(t("statusFailed", { message: err instanceof Error ? err.message : String(err) }))
    }
  }, [desktop, t])

  useEffect(() => {
    let cancelled = false
    if (!desktop) return
    void (async () => {
      try {
        const s = await fetchPushStatus()
        if (!cancelled) setStatus(s)
      } catch {
        // Initial load failures are surfaced when the user interacts;
        // don't toast on mount.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [desktop])

  const onSubmitFcm = useCallback(async () => {
    if (!fcmJson.trim()) {
      toast.error(t("fcmRequired"))
      return
    }
    setBusy(true)
    try {
      await configureFcm(fcmJson.trim())
      setFcmJson("")
      toast.success(t("fcmConfigured"))
      await refresh()
    } catch (err) {
      toast.error(
        t("fcmConfigureFailed", { message: err instanceof Error ? err.message : String(err) })
      )
    } finally {
      setBusy(false)
    }
  }, [fcmJson, refresh, t])

  const onClearFcm = useCallback(async () => {
    setBusy(true)
    try {
      await clearFcm()
      toast.success(t("fcmCleared"))
      await refresh()
    } catch (err) {
      toast.error(
        t("fcmClearFailed", { message: err instanceof Error ? err.message : String(err) })
      )
    } finally {
      setBusy(false)
    }
  }, [refresh, t])

  const onSubmitApns = useCallback(async () => {
    const required = ["keyId", "teamId", "bundleId", "privateKeyPem"] as const
    for (const field of required) {
      if (!apns[field].trim()) {
        toast.error(t("apnsFieldRequired", { field }))
        return
      }
    }
    setBusy(true)
    try {
      await configureApns(apns)
      toast.success(t("apnsConfigured"))
      setApns((prev) => ({ ...prev, privateKeyPem: "" }))
      await refresh()
    } catch (err) {
      toast.error(
        t("apnsConfigureFailed", { message: err instanceof Error ? err.message : String(err) })
      )
    } finally {
      setBusy(false)
    }
  }, [apns, refresh, t])

  const onClearApns = useCallback(async () => {
    setBusy(true)
    try {
      await clearApns()
      toast.success(t("apnsCleared"))
      await refresh()
    } catch (err) {
      toast.error(
        t("apnsClearFailed", { message: err instanceof Error ? err.message : String(err) })
      )
    } finally {
      setBusy(false)
    }
  }, [refresh, t])

  return (
    <Card data-testid="push-credentials-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
        <CardDescription className="text-xs">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!desktop && <p className="text-xs text-muted-foreground">{t("desktopOnly")}</p>}

        {/* FCM */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Label className="text-xs font-medium">{t("fcmLabel")}</Label>
            {status?.fcmConfigured ? (
              <Badge variant="outline" className="text-[10px] uppercase">
                {t("configured")}
              </Badge>
            ) : null}
          </div>
          <Textarea
            className="h-32 resize-y font-mono text-[10px]"
            placeholder={t("fcmPlaceholder")}
            value={fcmJson}
            onChange={(e) => setFcmJson(e.target.value)}
            disabled={!desktop || busy}
            aria-label={t("fcmAria")}
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={onSubmitFcm} disabled={!desktop || busy}>
              {t("saveFcm")}
            </Button>
            {status?.fcmConfigured && (
              <Button size="sm" variant="ghost" onClick={onClearFcm} disabled={!desktop || busy}>
                {t("clearFcm")}
              </Button>
            )}
          </div>
        </div>

        {/* APNs */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Label className="text-xs font-medium">{t("apnsLabel")}</Label>
            {status?.apnsConfigured ? (
              <Badge variant="outline" className="text-[10px] uppercase">
                {t("configured")}
              </Badge>
            ) : null}
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">{t("keyId")}</Label>
              <Input
                value={apns.keyId}
                onChange={(e) => setApns({ ...apns, keyId: e.target.value })}
                placeholder={t("apnsKeyIdPlaceholder")}
                disabled={!desktop || busy}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">{t("teamId")}</Label>
              <Input
                value={apns.teamId}
                onChange={(e) => setApns({ ...apns, teamId: e.target.value })}
                placeholder={t("apnsTeamIdPlaceholder")}
                disabled={!desktop || busy}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-[10px] text-muted-foreground">{t("bundleId")}</Label>
              <Input
                value={apns.bundleId}
                onChange={(e) => setApns({ ...apns, bundleId: e.target.value })}
                placeholder={t("apnsBundleIdPlaceholder")}
                disabled={!desktop || busy}
                className="font-mono text-xs"
              />
            </div>
          </div>
          <Textarea
            className="h-32 resize-y font-mono text-[10px]"
            placeholder={t("apnsKeyPlaceholder")}
            value={apns.privateKeyPem}
            onChange={(e) => setApns({ ...apns, privateKeyPem: e.target.value })}
            disabled={!desktop || busy}
            aria-label={t("apnsKeyAria")}
          />
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <Checkbox
                id="apns-production"
                checked={apns.production}
                onCheckedChange={(v) => setApns({ ...apns, production: v === true })}
                disabled={!desktop || busy}
                aria-label={t("productionAria")}
              />
              <Label htmlFor="apns-production" className="text-xs font-normal">
                {t("productionEnv")}
              </Label>
            </div>
            <Button size="sm" onClick={onSubmitApns} disabled={!desktop || busy}>
              {t("saveApns")}
            </Button>
            {status?.apnsConfigured && (
              <Button size="sm" variant="ghost" onClick={onClearApns} disabled={!desktop || busy}>
                {t("clearApns")}
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
