"use client"

/**
 * WebRTC remote-access settings card (ADR-0021).
 *
 * Lives under the Mobile companion settings tab alongside the existing
 * tunnel / mDNS cards. Owns the four `AppSettings` keys the WebRTC tier
 * reads on the mobile side:
 *
 *   - `webrtcEnabled`   — master toggle, default ON
 *   - `signalingUrl`    — wss:// endpoint of the rendezvous service
 *   - `iceServers`      — STUN entries, one per line in the textarea
 *   - `turnServers`     — TURN entries, encoded as
 *                         `turn:host:port?transport=udp|user|credential`
 *
 * The settings persist through the existing Dexie `settings` singleton
 * (`lib/db/settings.ts:saveSettings`), which is the same path the mobile
 * `app_settings_update` RPC ultimately rides — the allowlist in
 * `src-tauri/src/companion_api/rpc.rs` covers these keys (see ADR-0021).
 *
 * The status pane below the form polls two Tauri commands every 3 s:
 *   - `companion_signaling_status` — hub-level enabled flag + signaling URL
 *   - `companion_signaling_devices_status` — per-device tier (Offline /
 *     Awaiting / Negotiating / Connected / Failed) sourced from the Rust
 *     `SignalingHub::devices_status` snapshot.
 * Consecutive poll failures (≥ 3, i.e. ~9 s of unreachable hub) surface a
 * red banner above the device list so the user knows _why_ the tier
 * column hasn't refreshed.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { CircleIcon, GlobeIcon, RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { isTauri, transport } from "@/lib/tauri"
import {
  KEYRING_CREDENTIAL_PREFIX,
  freshCredentialKeyId,
  migrateTurnServersToKeyring,
  resolveTurnServerCredentials,
  saveTurnCredential,
} from "@/lib/credentials/turn-credentials"

const DEFAULT_SIGNALING_URL = "wss://signaling.cognia.app/v1/signaling"
const DEFAULT_STUN_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
]
const POLL_INTERVAL_MS = 3000
const POLL_FAILURE_BANNER_THRESHOLD = 3

interface FormState {
  enabled: boolean
  signalingUrl: string
  iceServersText: string
  turnServersText: string
}

const INITIAL: FormState = {
  enabled: true,
  signalingUrl: DEFAULT_SIGNALING_URL,
  iceServersText: DEFAULT_STUN_SERVERS.map((s) => urlsOf(s)).join("\n"),
  turnServersText: "",
}

interface SignalingStatusSnapshot {
  enabled: boolean
  signalingUrl: string
  registeredDevices: string[]
}

/** Mirror of `DeviceTier` in `src-tauri/src/companion_api/signaling/mod.rs`. */
export type DeviceTier = "offline" | "awaiting" | "negotiating" | "connected" | "failed"

/** Mirror of `DeviceTierEntry` (camelCase via serde). */
export interface DeviceTierEntry {
  deviceId: string
  rendezvousId: string
  tier: DeviceTier
  lastError?: string
  updatedAtMs: number
}

export function WebRtcCard() {
  const t = useTranslations("mobile.companion.webrtc")
  const [form, setForm] = useState<FormState>(INITIAL)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<SignalingStatusSnapshot | null>(null)
  const [devices, setDevices] = useState<DeviceTierEntry[] | null>(null)
  const [pollFailureCount, setPollFailureCount] = useState(0)
  const [pollFailureMessage, setPollFailureMessage] = useState<string | null>(null)

  // Hydrate from Dexie on mount. Also performs the silent migration
  // of any legacy plaintext TURN credentials into the OS keyring so the
  // user never has to re-enter them.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const s = await getSettings()
        if (cancelled) return
        const rawTurn = s.turnServers ?? []
        // S1 silent migration: plaintext → keyring. The result still
        // carries the same URL list, but `credential` is now a
        // `kr:<keyId>` sentinel. Persist back so the next hydrate is a
        // no-op.
        const { migrated: migratedTurn, didMigrate } = await migrateTurnServersToKeyring(rawTurn)
        if (didMigrate && !cancelled) {
          await saveSettings({ turnServers: migratedTurn })
        }
        // For display in the textarea we resolve sentinels back to
        // plaintext credentials — the textarea has always shown the
        // user the values it persists, and shipping a feature where
        // "TURN credentials disappear after save" would be a usability
        // regression.
        const displayTurn = await resolveTurnServerCredentials(migratedTurn)
        if (cancelled) return
        setForm({
          enabled: s.webrtcEnabled ?? true,
          signalingUrl: s.signalingUrl ?? DEFAULT_SIGNALING_URL,
          iceServersText: stringifyServers(s.iceServers ?? DEFAULT_STUN_SERVERS),
          turnServersText: stringifyServers(displayTurn),
        })
      } catch {
        // Dexie unavailable (SSR / first load) — keep INITIAL.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Poll the Rust hub for both the global status and the per-device tier
  // table every 3 s while the card is mounted. The two commands always
  // succeed or fail together (same hub, same dispatch path), so we treat
  // them as a single sample.
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const [snapshot, deviceRows] = await Promise.all([
          transport.call<SignalingStatusSnapshot>("companion_signaling_status"),
          transport.call<DeviceTierEntry[]>("companion_signaling_devices_status"),
        ])
        if (cancelled) return
        setStatus(snapshot)
        setDevices(deviceRows)
        setPollFailureCount(0)
        setPollFailureMessage(null)
      } catch (err) {
        if (cancelled) return
        setPollFailureCount((n) => n + 1)
        setPollFailureMessage(err instanceof Error ? err.message : String(err))
      }
      if (!cancelled) timer = setTimeout(refresh, POLL_INTERVAL_MS)
    }
    void refresh()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  const onSave = useCallback(async () => {
    const url = form.signalingUrl.trim()
    if (!/^wss?:\/\//i.test(url)) {
      toast.error(t("invalidUrl"))
      return
    }
    setBusy(true)
    try {
      const { servers: ice, invalid: invalidIce } = parseServers(form.iceServersText)
      const { servers: turn, invalid: invalidTurn } = parseServers(form.turnServersText)
      for (const bad of [...invalidIce, ...invalidTurn]) {
        toast.warning(t("invalidIceServer", { value: bad }))
      }
      // S1: TURN credentials never reach Dexie in plaintext. Each
      // entry's username + credential go straight to the OS keyring;
      // Dexie keeps only the URL list and a keyring sentinel. Existing
      // sentinels (the user didn't change credentials between saves)
      // are detected by `parseServers` returning the `kr:...` value
      // verbatim — we then leave them alone.
      const turnPersisted: RTCIceServer[] = []
      for (const entry of turn) {
        const credential = typeof entry.credential === "string" ? entry.credential : ""
        if (credential.startsWith(KEYRING_CREDENTIAL_PREFIX)) {
          // Already a sentinel — pass through. Migration handles the
          // legacy plaintext path on hydrate; this branch covers a
          // round-trip where the textarea string isn't resolved by
          // the time the user clicks Save.
          turnPersisted.push(entry)
          continue
        }
        if (!entry.username || !credential) {
          // Auth-less TURN entry (rare; usually invalid). Persist
          // without touching the keyring.
          turnPersisted.push(entry)
          continue
        }
        const keyId = freshCredentialKeyId()
        await saveTurnCredential(keyId, {
          username: entry.username,
          credential,
        })
        turnPersisted.push({
          urls: entry.urls,
          credential: `${KEYRING_CREDENTIAL_PREFIX}${keyId}`,
        })
      }
      await saveSettings({
        webrtcEnabled: form.enabled,
        signalingUrl: url,
        iceServers: ice.length > 0 ? ice : undefined,
        turnServers: turnPersisted.length > 0 ? turnPersisted : undefined,
      })
      toast.success(t("saved"))
    } catch (err) {
      toast.error(
        t("saveFailed", {
          reason: err instanceof Error ? err.message : String(err),
        })
      )
    } finally {
      setBusy(false)
    }
  }, [form, t])

  const showPollBanner = pollFailureCount >= POLL_FAILURE_BANNER_THRESHOLD

  return (
    <Card data-testid="webrtc-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-2 text-sm font-medium">
          <span className="flex items-center gap-2">
            <GlobeIcon className="h-4 w-4" />
            {t("title")}
          </span>
          <Switch
            checked={form.enabled}
            onCheckedChange={(v) => setForm((prev) => ({ ...prev, enabled: v }))}
            aria-label={t("enableLabel")}
            data-testid="webrtc-enable-toggle"
          />
        </CardTitle>
        <CardDescription className="text-xs">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">{t("enableHelp")}</p>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="webrtc-signaling-url" className="text-xs font-medium">
            {t("signalingUrlLabel")}
          </Label>
          <Input
            id="webrtc-signaling-url"
            value={form.signalingUrl}
            onChange={(e) => setForm((prev) => ({ ...prev, signalingUrl: e.target.value }))}
            placeholder={t("signalingUrlPlaceholder")}
            disabled={busy}
            className="font-mono text-xs"
          />
          <p className="text-[10px] text-muted-foreground">{t("signalingUrlHelp")}</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="webrtc-ice-servers" className="text-xs font-medium">
            {t("iceServersLabel")}
          </Label>
          <Textarea
            id="webrtc-ice-servers"
            value={form.iceServersText}
            onChange={(e) => setForm((prev) => ({ ...prev, iceServersText: e.target.value }))}
            disabled={busy}
            className="min-h-16 font-mono text-xs"
          />
          <p className="text-[10px] text-muted-foreground">{t("iceServersHelp")}</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="webrtc-turn-servers" className="text-xs font-medium">
            {t("turnServersLabel")}
          </Label>
          <Textarea
            id="webrtc-turn-servers"
            value={form.turnServersText}
            onChange={(e) => setForm((prev) => ({ ...prev, turnServersText: e.target.value }))}
            disabled={busy}
            className="min-h-16 font-mono text-xs"
            placeholder={t("turnServersPlaceholder")}
          />
          <p className="text-[10px] text-muted-foreground">{t("turnServersHelp")}</p>
        </div>

        <Button size="sm" onClick={onSave} disabled={busy} data-testid="webrtc-save">
          {busy ? t("savingButton") : t("saveButton")}
        </Button>

        {showPollBanner ? (
          <div
            className="flex flex-col gap-0.5 rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            data-testid="webrtc-poll-error"
            role="alert"
          >
            <span className="font-medium">
              {t("pollFailed", { reason: pollFailureMessage ?? "" })}
            </span>
          </div>
        ) : null}

        {status ? <StatusBlock status={status} devices={devices} /> : null}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Status sub-tree — exported for direct rendering in tests.
// ---------------------------------------------------------------------------

interface StatusBlockProps {
  status: SignalingStatusSnapshot
  devices: DeviceTierEntry[] | null
}

function StatusBlock({ status, devices }: StatusBlockProps): React.JSX.Element {
  const t = useTranslations("mobile.companion.webrtc")
  const [pendingReconnect, setPendingReconnect] = useState<string | null>(null)

  const onReconnect = useCallback(
    async (rendezvousId: string) => {
      setPendingReconnect(rendezvousId)
      try {
        await transport.call<void>("companion_signaling_reconnect_device", {
          rendezvousId,
        })
        toast.success(t("reconnectSuccess"))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // The Rust hub throttles repeated reconnects with an error
        // string prefixed `reconnect_throttled:`; surface that as a
        // warning instead of an error toast so the user understands
        // the action wasn't a failure on the desktop side.
        if (msg.startsWith("reconnect_throttled")) {
          toast.warning(t("reconnectThrottled"))
        } else {
          toast.error(t("reconnectFailed", { reason: msg }))
        }
      } finally {
        setPendingReconnect(null)
      }
    },
    [t]
  )

  // Hub disabled (master toggle off) — render a single Offline row.
  if (!status.enabled) {
    return (
      <div
        className="flex items-center gap-2 rounded border bg-card px-3 py-2 text-xs"
        data-testid="webrtc-status-disabled"
        role="status"
        aria-live="polite"
      >
        <TierDot tier="offline" />
        <span className="font-medium">{t("deviceTier.offline")}</span>
      </div>
    )
  }

  // No paired devices ever registered — surface an empty-state hint.
  if (!devices || devices.length === 0) {
    return (
      <div
        className="rounded border bg-card px-3 py-2 text-xs text-muted-foreground"
        data-testid="webrtc-status-empty"
        role="status"
        aria-live="polite"
      >
        {t("noDevices")}
      </div>
    )
  }

  return (
    <ul
      className="flex flex-col gap-1 rounded border bg-card p-1.5 text-xs"
      data-testid="webrtc-device-tier-list"
      role="status"
      aria-live="polite"
    >
      {devices.map((d) => (
        <li
          key={d.rendezvousId}
          className="flex flex-col gap-1 rounded px-2 py-1.5 sm:flex-row sm:items-center sm:gap-2"
          data-testid={`webrtc-device-row-${d.deviceId}`}
        >
          <TierDot tier={d.tier} />
          <span
            className="font-mono text-[10px] text-muted-foreground sm:flex-1"
            title={d.deviceId}
          >
            {truncateId(d.deviceId)}
          </span>
          <span className="font-medium">{t(`deviceTier.${d.tier}`)}</span>
          {d.lastError && d.tier === "failed" ? (
            <span className="text-[10px] text-destructive sm:ml-2" title={d.lastError}>
              {truncateError(d.lastError)}
            </span>
          ) : null}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="ml-auto size-6 shrink-0"
            disabled={pendingReconnect === d.rendezvousId}
            onClick={() => {
              void onReconnect(d.rendezvousId)
            }}
            aria-label={t("reconnectButton")}
            title={t("reconnectButton")}
            data-testid={`webrtc-reconnect-${d.deviceId}`}
          >
            <RefreshCwIcon
              aria-hidden="true"
              className={cn("size-3.5", pendingReconnect === d.rendezvousId && "animate-spin")}
            />
          </Button>
        </li>
      ))}
    </ul>
  )
}

interface TierDotProps {
  tier: DeviceTier
  className?: string
}

/** Color-coded status dot shared between the desktop card and the mobile
 *  tier indicator. Five colors → five tiers, one source of truth. */
export function TierDot({ tier, className }: TierDotProps): React.JSX.Element {
  const palette: Record<DeviceTier, string> = {
    connected: "fill-emerald-500 text-emerald-500",
    negotiating: "fill-amber-500 text-amber-500",
    awaiting: "fill-sky-500 text-sky-500",
    failed: "fill-destructive text-destructive",
    offline: "fill-muted-foreground text-muted-foreground",
  }
  return (
    <CircleIcon aria-hidden="true" className={cn("size-2 shrink-0", palette[tier], className)} />
  )
}

// ---------------------------------------------------------------------------
// Helpers — exported for unit testing.
// ---------------------------------------------------------------------------

/** Renders a `RTCIceServer.urls` (string | string[]) back as one URL per line. */
function urlsOf(server: RTCIceServer): string {
  const list = Array.isArray(server.urls) ? server.urls : [server.urls]
  return list.join("\n")
}

/** Encode `RTCIceServer[]` into the textarea text format. */
export function stringifyServers(servers: RTCIceServer[]): string {
  return servers
    .map((s) => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls]
      return urls
        .map((u) => {
          if (s.username && s.credential) {
            return `${u}|${s.username}|${s.credential}`
          }
          return u
        })
        .join("\n")
    })
    .join("\n")
}

export interface ParseServersResult {
  servers: RTCIceServer[]
  /** Invalid lines that were skipped. The caller toasts these. */
  invalid: string[]
}

/**
 * Parse one URL per line, with optional `|username|credential` suffix for
 * TURN entries. Blank lines and `#` comments are ignored.
 */
export function parseServers(text: string): ParseServersResult {
  const servers: RTCIceServer[] = []
  const invalid: string[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const parts = line.split("|")
    const url = parts[0]?.trim() ?? ""
    if (!/^(stun|turn|turns):/i.test(url)) {
      invalid.push(line)
      continue
    }
    const isTurn = /^turns?:/i.test(url)
    if (isTurn) {
      if (parts.length < 3 || !parts[1] || !parts[2]) {
        invalid.push(line)
        continue
      }
      servers.push({
        urls: url,
        username: parts[1].trim(),
        credential: parts[2].trim(),
      })
    } else {
      servers.push({ urls: url })
    }
  }
  return { servers, invalid }
}

function truncateId(deviceId: string): string {
  // Device IDs are UUIDs (~36 chars); show enough to disambiguate without
  // overflowing on narrow mobile previews. Falls back to the full string
  // for short identifiers.
  if (deviceId.length <= 14) return deviceId
  return `${deviceId.slice(0, 6)}…${deviceId.slice(-4)}`
}

function truncateError(message: string): string {
  if (message.length <= 60) return message
  return `${message.slice(0, 57)}…`
}
