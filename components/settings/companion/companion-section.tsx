"use client"

/**
 * Mobile Companion settings — desktop-side surface for the companion API
 * (M2.8). Three cards:
 *
 *   1. Server status: master toggle + bind-mode radio (loopback / LAN) +
 *      live "running on http://x.y.z.w:7890" status row.
 *   2. Pair a new device: button generates a one-shot pair JWT, renders a QR
 *      whose payload is `{baseUrl, pair_jwt, server_version}` (the M4.5 phone
 *      scanner expects this shape) plus a 5-minute countdown.
 *   3. Paired devices: table backed by `useLiveQuery(listPairedDevices)`.
 *      Each row exposes a revoke button that calls both Dexie's
 *      `revokePairedDevice` and the Rust `companion_revoke_device` deny-list.
 *
 * V1 ships plain HTTP — when the user picks LAN binding, the card renders an
 * inline warning that the server is reachable on the local network without
 * TLS. Self-signed certs + cloudflared are deferred to M2.9.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronDownIcon,
  CircleIcon,
  CopyIcon,
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
import { listPairedDevices } from "@/lib/db/paired-devices"
import { encodePairPayload } from "@/lib/qr/pair-payload"
import { cn } from "@/lib/utils"
import { APP_VERSION } from "@/lib/app-version"
import { PairedDevicesCard } from "./paired-devices-card"
import { WebRtcCard } from "./webrtc-card"
import { SyncStatusCard } from "./sync-status-card"

// ---------------------------------------------------------------------------
// Tauri command shapes — mirror src-tauri/src/companion_api/commands.rs
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 7890

type BindMode = "loopback" | "lan"

interface CompanionServerStatus {
  running: boolean
  bindMode: "loopback" | "lan" | "none"
  boundPort: number | null
}

interface PairJwtIssue {
  pairJwt: string
  expiresAtMs: number
  baseUrl: string
  /** SHA-256 SubjectPublicKeyInfo fingerprint (Wave 1.4). Empty if absent. */
  fingerprint?: string
  /** Server app version (Wave 1.7 v2 payload). */
  appVersion?: string
  /** 6-digit emulator-friendly pair code (Wave 4.x). Same TTL as the JWT.
   *  Optional so older Rust desktops returning the legacy shape still
   *  decode — the UI renders only when present. */
  pairCode?: string
  pairCodeExpiresAtMs?: number
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
  // Re-seed the Rust remote-control allow list from the persisted Dexie
  // grants so the elevated capability survives a desktop restart. Replace
  // semantics — a grant revoked while the desktop was down is not retained.
  // Best-effort: a failure here only means a granted phone must re-toggle.
  await seedRemoteControlAllowList()
  return port
}

async function seedRemoteControlAllowList(): Promise<void> {
  if (!isTauri()) return
  try {
    const devices = await listPairedDevices()
    const allowed = devices
      .filter((d) => d.allowRemoteControl === true && d.revokedAt === undefined)
      .map((d) => d.deviceId)
    await transport.call<void>("companion_seed_remote_control", { deviceIds: allowed })
  } catch (err) {
    console.warn("seedRemoteControlAllowList failed", err)
  }
}

async function stopServer(): Promise<void> {
  await transport.call<void>("companion_server_stop")
}

async function issuePairJwt(): Promise<PairJwtIssue> {
  return transport.call<PairJwtIssue>("companion_issue_pair_jwt")
}

async function startMdnsBroadcast(args: {
  port: number
  appVersion: string
  tlsFingerprint: string
}): Promise<string> {
  return transport.call<string>("companion_mdns_start", args)
}

async function stopMdnsBroadcast(): Promise<void> {
  await transport.call<void>("companion_mdns_stop")
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

async function saveNamedConfig(token: string, hostname: string): Promise<void> {
  return transport.call<void>("companion_tunnel_save_named_config", { token, hostname })
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
        <ServerStatusCard />
        <TunnelCard />
        <MdnsCard />
        <WebRtcCard />
      </CompanionGroup>
      <CompanionGroup id="pairing" title={t("pairing")} defaultOpen>
        <PairDeviceCard />
        <PairedDevicesCard />
      </CompanionGroup>
      <CompanionGroup id="push" title={t("push")} defaultOpen>
        <PushCredentialsCard />
      </CompanionGroup>
      {/* Diagnostics + per-table sync state are power-user surfaces; collapse
          them by default so the common pairing / push path isn't buried. */}
      <CompanionGroup id="advanced" title={t("advanced")} defaultOpen={false}>
        <SyncStatusCard />
        <ReachabilityDiagnosticsCard />
      </CompanionGroup>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Collapsible group wrapper — labeled section header + chevron. Inlined here
// (not its own file) so it rides the existing companion-section.test.tsx
// coverage; its only behavior is open/close, exercised by the section tests.
// ---------------------------------------------------------------------------

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
      await saveNamedConfig(tokenInput.trim(), hostnameInput.trim())
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
            <span>{info ? info.publicUrl : t("off")}</span>
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

  useEffect(() => {
    let cancelled = false
    void getMdnsStatus()
      .then((s) => {
        if (!cancelled) setRunning(s)
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
          const fingerprint = await transport
            .call<string>("companion_get_tls_fingerprint")
            .catch(() => "")
          await startMdnsBroadcast({
            port: DEFAULT_PORT,
            appVersion: APP_VERSION,
            tlsFingerprint: fingerprint,
          })
          setRunning(true)
          toast.success(t("started"))
        } else {
          await stopMdnsBroadcast()
          setRunning(false)
          toast.success(t("stopped"))
        }
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
          toast.success(t("started", { port }))
        } else {
          await stopServer()
          setStatus({ running: false, bindMode: "none", boundPort: null })
          toast.success(t("stopped"))
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
      if (!desktop || !status.running) return
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
        {!desktop && <p className="text-xs text-muted-foreground">{t("desktopOnly")}</p>}
      </CardContent>
    </Card>
  )
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
      <span className="text-[10px] uppercase text-muted-foreground" title="Desktop-only">
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
  const [issue, setIssue] = useState<PairJwtIssue | null>(null)
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
    setBusy(true)
    try {
      const next = await issuePairJwt()
      setIssue(next)
      setNow(Date.now())
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [desktop, t])

  const expired = issue ? now >= issue.expiresAtMs : false
  const remainingSecs = issue ? Math.max(0, Math.floor((issue.expiresAtMs - now) / 1000)) : 0

  // QR payload v2 — `cgnp2|<base64url(json)>` carrying the TLS fingerprint
  // alongside baseUrl + pair JWT. The mobile scanner pins the fingerprint
  // against the desktop's actual cert (Wave 1.4). Falls back to the legacy
  // bare-JSON shape when the desktop doesn't yet surface a fingerprint.
  const qrPayload = useMemo(() => {
    if (!issue) return null
    return encodePairPayload({
      baseUrl: issue.baseUrl,
      pairJwt: issue.pairJwt,
      version: issue.appVersion ?? APP_VERSION,
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
        {issue?.pairCode && (
          <PairCodeBlock
            code={issue.pairCode}
            expired={expired}
            label={t("codeLabel")}
            copyLabel={t("codeCopy")}
            copiedLabel={t("codeCopied")}
            hint={t("codeHint")}
          />
        )}
        {issue && (
          <p className="break-all text-[10px] font-mono text-muted-foreground">{issue.baseUrl}</p>
        )}
      </CardContent>
    </Card>
  )
}

interface PairCodeBlockProps {
  code: string
  expired: boolean
  label: string
  copyLabel: string
  copiedLabel: string
  hint: string
}

function PairCodeBlock({ code, expired, label, copyLabel, copiedLabel, hint }: PairCodeBlockProps) {
  const [copied, setCopied] = useState(false)

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard API unavailable (older WebView / locked-down env).
      // The user can still read the digits off the screen.
    }
  }, [code])

  return (
    <div
      className={cn("flex flex-col gap-2 rounded border bg-card p-3", expired && "opacity-50")}
      data-testid="pair-code-block"
      data-expired={expired ? "true" : "false"}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1 px-2"
          onClick={() => void onCopy()}
          disabled={expired}
          aria-label={copyLabel}
          data-testid="pair-code-copy"
        >
          {copied ? (
            <>
              <CheckIcon className="size-3.5" aria-hidden="true" />
              {copiedLabel}
            </>
          ) : (
            <>
              <CopyIcon className="size-3.5" aria-hidden="true" />
              {copyLabel}
            </>
          )}
        </Button>
      </div>
      <p
        className="select-all text-center font-mono text-2xl tracking-[0.3em]"
        aria-label={label}
        data-testid="pair-code-digits"
      >
        {code}
      </p>
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
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

interface ReachabilityRow {
  url: string
  reachable: boolean
  latencyMs?: number
  error?: string
}

async function probeLocalReachability(): Promise<ReachabilityRow[]> {
  if (!isTauri()) return []
  return transport.call<ReachabilityRow[]>("companion_test_local_reachability")
}

function ReachabilityDiagnosticsCard() {
  const [rows, setRows] = useState<ReachabilityRow[] | null>(null)
  const [busy, setBusy] = useState(false)
  const desktop = isTauri()
  const t = useTranslations("mobile.companion.diagnostics")

  const onTest = useCallback(async () => {
    setBusy(true)
    try {
      const out = await probeLocalReachability()
      setRows(out)
    } catch (err) {
      toast.error(t("probeFailed", { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }, [t])

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
        <CardDescription className="text-xs">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button size="sm" variant="outline" onClick={onTest} disabled={!desktop || busy}>
          {busy ? t("probing") : t("testButton")}
        </Button>
        {!desktop && <p className="text-xs text-muted-foreground">{t("desktopOnly")}</p>}
        {rows && rows.length > 0 && (
          <div className="space-y-1.5">
            {rows.map((row) => (
              <div
                key={row.url}
                className={cn(
                  "flex items-start gap-2 rounded border px-3 py-2 text-xs",
                  row.reachable
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300"
                )}
              >
                <CircleIcon
                  className={cn("mt-0.5 h-2 w-2 shrink-0 fill-current", row.reachable ? "" : "")}
                />
                <div className="flex-1 space-y-0.5">
                  <div className="font-mono">{row.url}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {row.reachable
                      ? `${t("ok")} · ${row.latencyMs ?? "—"} ${t("ms")}`
                      : `${t("failed")}${row.error ? ` · ${row.error}` : ""}`}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        {rows && rows.length === 0 && <p className="text-xs text-muted-foreground">{t("empty")}</p>}
      </CardContent>
    </Card>
  )
}

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
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">{t("keyId")}</Label>
              <Input
                value={apns.keyId}
                onChange={(e) => setApns({ ...apns, keyId: e.target.value })}
                placeholder="ABC1234DEF"
                disabled={!desktop || busy}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">{t("teamId")}</Label>
              <Input
                value={apns.teamId}
                onChange={(e) => setApns({ ...apns, teamId: e.target.value })}
                placeholder="TEAM1234DE"
                disabled={!desktop || busy}
                className="font-mono text-xs"
              />
            </div>
            <div className="col-span-2 space-y-1">
              <Label className="text-[10px] text-muted-foreground">{t("bundleId")}</Label>
              <Input
                value={apns.bundleId}
                onChange={(e) => setApns({ ...apns, bundleId: e.target.value })}
                placeholder="com.cognia.mobile"
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
