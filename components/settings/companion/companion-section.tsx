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
import { useLiveQuery } from "dexie-react-hooks"
import {
  CircleIcon,
  QrCodeIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  SmartphoneIcon,
  TrashIcon,
} from "lucide-react"
import { QRCodeSVG } from "qrcode.react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { isTauri, transport } from "@/lib/tauri"
import { listPairedDevices, revokePairedDevice } from "@/lib/db/paired-devices"
import { encodePairPayload } from "@/lib/qr/pair-payload"
import { useBiometricGuard } from "@/hooks/use-biometric-guard"
import { cn } from "@/lib/utils"

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
  return transport.call<number>("companion_server_start", {
    port: DEFAULT_PORT,
    bindLoopbackOnly: bindMode === "loopback",
  })
}

async function stopServer(): Promise<void> {
  await transport.call<void>("companion_server_stop")
}

async function issuePairJwt(): Promise<PairJwtIssue> {
  return transport.call<PairJwtIssue>("companion_issue_pair_jwt")
}

async function revokeDeviceRustSide(deviceId: string): Promise<void> {
  if (!isTauri()) return
  await transport.call<void>("companion_revoke_device", { deviceId })
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

// ---------------------------------------------------------------------------
// Top-level section
// ---------------------------------------------------------------------------

export function CompanionSection() {
  return (
    <div className="space-y-4 p-4" data-testid="companion-section">
      <ServerStatusCard />
      <TunnelCard />
      <MdnsCard />
      <PairDeviceCard />
      <PairedDevicesCard />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tunnel card (Wave 1.6) — Cloudflared launcher
// ---------------------------------------------------------------------------

function TunnelCard() {
  const desktop = isTauri()
  const [info, setInfo] = useState<TunnelInfo | null>(null)
  const [busy, setBusy] = useState(false)

  // Hydrate current tunnel state on mount.
  useEffect(() => {
    let cancelled = false
    void getTunnelInfo()
      .then((current) => {
        if (!cancelled) setInfo(current)
      })
      .catch(() => {
        // Best effort.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const onToggle = useCallback(
    async (enabled: boolean) => {
      if (!desktop) {
        toast.error("隧道仅在桌面运行时可用。")
        return
      }
      setBusy(true)
      try {
        if (enabled) {
          // For now we point the tunnel at the loopback HTTP companion server
          // (Wave 1.4 TLS server is wired but cargo bind is HITL). When the
          // HTTPS port lands the localUrl will switch to https://127.0.0.1:7891.
          const next = await startTunnel(`http://127.0.0.1:${DEFAULT_PORT}`)
          setInfo(next)
          toast.success("隧道已启动。")
        } else {
          await stopTunnel()
          setInfo(null)
          toast.success("隧道已停止。")
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/cloudflared.*not.found|not.installed/i.test(msg)) {
          toast.error("找不到 cloudflared，先 brew/winget/apt 安装。")
        } else {
          toast.error(msg)
        }
      } finally {
        setBusy(false)
      }
    },
    [desktop]
  )

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-2 text-sm font-medium">
          <span className="flex items-center gap-2">Cloudflared 隧道</span>
          <Switch
            checked={!!info}
            onCheckedChange={onToggle}
            disabled={!desktop || busy}
            aria-label="Enable cloudflared tunnel"
          />
        </CardTitle>
        <CardDescription className="text-xs">
          出门在外时让手机能连上桌面。需先安装 cloudflared CLI。
        </CardDescription>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">
        {info ? (
          <p className="break-all font-mono" data-testid="tunnel-public-url">
            {info.publicUrl}
          </p>
        ) : (
          <p>关闭中。开关打开后会以子进程方式拉起 cloudflared。</p>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// mDNS card (Wave 1.5) — LAN broadcast toggle
// ---------------------------------------------------------------------------

function MdnsCard() {
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
        toast.error("LAN 广播仅在桌面运行时可用。")
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
            appVersion: SERVER_VERSION,
            tlsFingerprint: fingerprint,
          })
          setRunning(true)
          toast.success("LAN 广播已启动。")
        } else {
          await stopMdnsBroadcast()
          setRunning(false)
          toast.success("LAN 广播已停止。")
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [desktop]
  )

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-2 text-sm font-medium">
          <span>LAN 自动发现 (mDNS)</span>
          <Switch
            checked={running}
            onCheckedChange={onToggle}
            disabled={!desktop || busy}
            aria-label="Enable mDNS broadcast"
          />
        </CardTitle>
        <CardDescription className="text-xs">
          在局域网广播 <code>_cognia._tcp</code>，手机不用扫码也能找到桌面。
        </CardDescription>
      </CardHeader>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Card 1 — server status + master toggle + bind-mode radio
// ---------------------------------------------------------------------------

function ServerStatusCard() {
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
        toast.error("Companion server is desktop-only.")
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
          toast.success(`Companion server listening on port ${port}.`)
        } else {
          await stopServer()
          setStatus({ running: false, bindMode: "none", boundPort: null })
          toast.success("Companion server stopped.")
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [desktop, desiredBind]
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
            Mobile companion server
            <StatusBadge status={status} desktop={desktop} />
          </span>
          <Switch
            checked={status.running}
            onCheckedChange={onToggleEnabled}
            disabled={!desktop || busy}
            aria-label="Enable companion server"
          />
        </CardTitle>
        <CardDescription className="text-xs">
          {status.running && status.boundPort !== null
            ? `Listening on http://${status.bindMode === "lan" ? "<your-LAN-IP>" : "127.0.0.1"}:${status.boundPort}`
            : "Server is off. Phones cannot reach this device."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div>
          <Label className="mb-2 block text-xs text-muted-foreground">Bind mode</Label>
          <RadioGroup
            value={desiredBind}
            onValueChange={onBindModeChange}
            className="space-y-2"
            aria-label="Bind mode"
          >
            <div className="flex items-start gap-3 rounded border bg-card px-3 py-2">
              <RadioGroupItem value="loopback" id="bind-loopback" disabled={!desktop || busy} />
              <div className="space-y-0.5">
                <Label htmlFor="bind-loopback" className="text-sm font-medium">
                  Loopback (this device only)
                </Label>
                <p className="text-xs text-muted-foreground">
                  Safest. The companion API is only reachable from the desktop itself — useful for
                  testing the QR flow.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded border bg-card px-3 py-2">
              <RadioGroupItem value="lan" id="bind-lan" disabled={!desktop || busy} />
              <div className="space-y-0.5">
                <Label htmlFor="bind-lan" className="text-sm font-medium">
                  LAN (phones on the same Wi-Fi)
                </Label>
                <p className="text-xs text-muted-foreground">
                  Required to actually pair a phone. Reachable on every interface on the local
                  network.
                </p>
              </div>
            </div>
          </RadioGroup>
        </div>
        {lanWarning && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
          >
            <ShieldAlertIcon className="h-3.5 w-3.5 shrink-0" />
            <span>
              Plain HTTP is in use — only enable LAN binding on trusted Wi-Fi. TLS will land in
              M2.9.
            </span>
          </div>
        )}
        {!desktop && (
          <p className="text-xs text-muted-foreground">
            Companion server runs in the desktop process — switch to the Tauri build to manage it.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function StatusBadge({ status, desktop }: { status: CompanionServerStatus; desktop: boolean }) {
  if (!desktop) {
    return (
      <span className="text-[10px] uppercase text-muted-foreground" title="Desktop-only">
        web
      </span>
    )
  }
  return status.running ? (
    <span className="flex items-center gap-1 text-[10px] uppercase text-emerald-500">
      <CircleIcon className="h-2 w-2 fill-current" />
      live
    </span>
  ) : (
    <span className="flex items-center gap-1 text-[10px] uppercase text-muted-foreground">
      <CircleIcon className="h-2 w-2 fill-current" />
      idle
    </span>
  )
}

// ---------------------------------------------------------------------------
// Card 2 — Pair a new device (QR + countdown)
// ---------------------------------------------------------------------------

const SERVER_VERSION = "0.1.0"

function PairDeviceCard() {
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
      toast.error("Companion pairing is desktop-only.")
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
  }, [desktop])

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
      version: issue.appVersion ?? SERVER_VERSION,
      fingerprint: issue.fingerprint ?? "",
    })
  }, [issue])

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <QrCodeIcon className="h-4 w-4" />
          Pair a new device
        </CardTitle>
        <CardDescription className="text-xs">
          Generate a QR code, scan it with the cognia mobile app, and the phone exchanges the
          one-shot token for a long-lived device JWT.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={onGenerate}
            disabled={!desktop || busy}
            aria-label="Generate QR"
          >
            <QrCodeIcon className="mr-1 h-3.5 w-3.5" />
            {issue ? "Refresh QR" : "Generate QR"}
          </Button>
          {issue && (
            <span
              className={cn("text-xs", expired ? "text-destructive" : "text-muted-foreground")}
              aria-live="polite"
            >
              {expired
                ? "Token expired — refresh to issue a new one."
                : `Expires in ${formatRemaining(remainingSecs)}`}
            </span>
          )}
        </div>
        {issue && qrPayload && !expired && (
          <div
            className="flex w-full justify-center rounded border bg-white p-4"
            data-testid="pair-qr-canvas"
          >
            <QRCodeSVG value={qrPayload} size={224} level="M" aria-label="Pairing QR code" />
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
// Card 3 — paired devices table
// ---------------------------------------------------------------------------

function PairedDevicesCard() {
  const rows = useLiveQuery(() => listPairedDevices(), [], [])
  const guard = useBiometricGuard()

  const onRevoke = useCallback(
    async (deviceId: string, label: string) => {
      const result = await guard(
        {
          reason: `确认解除 ${label} 的配对`,
          title: "解除配对",
          description: "解除后此设备将立即失去访问权限。",
        },
        async () => {
          await revokePairedDevice(deviceId)
          await revokeDeviceRustSide(deviceId)
        }
      )
      if (result.kind === "blocked") {
        if (result.reason === "cancelled") {
          // Silent — user backed out.
          return
        }
        toast.error(`解除配对未完成（${result.reason}）。`)
        return
      }
      toast.success("Device revoked.")
    },
    [guard]
  )

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Paired devices</CardTitle>
        <CardDescription className="text-xs">
          Revoking deny-lists the device JWT immediately. The row stays for audit.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!rows || rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No devices paired yet — generate a QR to add one.
          </p>
        ) : (
          <div className="max-h-[360px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>Platform</TableHead>
                  <TableHead>Paired</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead className="w-[80px] text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.deviceId}>
                    <TableCell className="text-sm">
                      <div className="flex items-center gap-2">
                        <span>{row.label}</span>
                        {row.revokedAt !== undefined && (
                          <Badge variant="outline" className="text-[10px]">
                            revoked
                          </Badge>
                        )}
                      </div>
                      <div className="text-[10px] font-mono text-muted-foreground">
                        v{row.appVersion}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs uppercase">{row.platform}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatRelative(row.pairedAt)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatRelative(row.lastSeenAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onRevoke(row.deviceId, row.label)}
                        disabled={row.revokedAt !== undefined}
                        aria-label={`Revoke ${row.label}`}
                      >
                        {row.revokedAt !== undefined ? (
                          <RefreshCwIcon className="h-3.5 w-3.5" />
                        ) : (
                          <TrashIcon className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Tiny relative-time formatter — no `date-fns` here because the section
 * only needs five buckets and a project-wide bundling change is out of
 * scope.
 */
function formatRelative(epochMs: number): string {
  const delta = Date.now() - epochMs
  if (delta < 60_000) return "just now"
  if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / (60 * 60_000))}h ago`
  return `${Math.floor(delta / (24 * 60 * 60_000))}d ago`
}
