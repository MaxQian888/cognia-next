"use client"

import { useCallback, useEffect, useState } from "react"

import { useBiometricGuard } from "@/hooks/use-biometric-guard"
import { scan as scanBarcode } from "@/lib/capacitor/barcode"
import { decodePairPayload } from "@/lib/qr/pair-payload"
import { parsePairQrPayload } from "@/lib/qr/pair-qr"
import { transport } from "@/lib/tauri"
import {
  clearCompanionConfig,
  hydrateCompanionConfig,
  saveCompanionConfig,
} from "@/lib/tauri/transport-companion"
import type { CompanionConfig } from "@/lib/tauri/transport-companion"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Phase =
  | { kind: "loading" }
  | { kind: "idle" }
  | { kind: "pairing" }
  | { kind: "paired"; deviceId: string; serverVersion: string }
  | { kind: "smoke-call-ok"; payload: unknown }
  | { kind: "smoke-ws-ok"; lastFrame: unknown }
  | { kind: "error"; message: string; recoverable: boolean }

interface PairResponseBody {
  device_id: string
  device_jwt: string
  server_version: string
}

const SMOKE_RPC = "claude_sidecar_status"
const SMOKE_WS_CHANNEL = "claude://session-event"

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PairOnboardingClient() {
  const [baseUrl, setBaseUrl] = useState("")
  const [pairJwt, setPairJwt] = useState("")
  /**
   * Server TLS fingerprint pulled out of a v2 QR payload (Wave 1.4 / 1.7).
   * Empty when the user pasted a v1 JSON-only payload — pairing still
   * works in that path but the transport layer can't pin.
   */
  const [serverFingerprint, setServerFingerprint] = useState("")
  const [phase, setPhase] = useState<Phase>({ kind: "loading" })
  const guard = useBiometricGuard()

  // Hydrate cache from SecureStorage / localStorage on mount so a paired
  // device skips the form and lands on the smoke screen.
  useEffect(() => {
    let cancelled = false
    void hydrateCompanionConfig()
      .then((cfg) => {
        if (cancelled) return
        if (cfg) {
          setPhase({
            kind: "paired",
            deviceId: cfg.deviceId,
            serverVersion: cfg.serverVersion,
          })
        } else {
          setPhase({ kind: "idle" })
        }
      })
      .catch(() => {
        if (cancelled) return
        // Hydration failure → still let the user pair (form path).
        setPhase({ kind: "idle" })
      })
    return () => {
      cancelled = true
    }
  }, [])

  const onPair = useCallback(async () => {
    const trimmedUrl = baseUrl.trim().replace(/\/+$/, "")
    const trimmedJwt = pairJwt.trim()

    const urlError = validateBaseUrl(trimmedUrl)
    if (urlError) {
      setPhase({ kind: "error", message: urlError, recoverable: true })
      return
    }
    const jwtError = validatePairJwt(trimmedJwt)
    if (jwtError) {
      setPhase({ kind: "error", message: jwtError, recoverable: true })
      return
    }

    setPhase({ kind: "pairing" })

    try {
      const response = await fetch(`${trimmedUrl}/api/v1/auth/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pair_jwt: trimmedJwt,
          device_label: getDeviceLabel(),
          device_platform: getDevicePlatform(),
          device_pubkey: "",
          app_version: "0.1.0",
        }),
      })

      if (!response.ok) {
        setPhase({
          kind: "error",
          message: describeHttpError(response.status, await safeText(response)),
          recoverable: true,
        })
        return
      }

      const body = (await response.json()) as PairResponseBody
      const config: CompanionConfig = {
        baseUrl: trimmedUrl,
        deviceJwt: body.device_jwt,
        deviceId: body.device_id,
        serverVersion: body.server_version,
      }
      if (serverFingerprint) {
        config.serverFingerprint = serverFingerprint
      }
      await saveCompanionConfig(config)
      setPhase({
        kind: "paired",
        deviceId: config.deviceId,
        serverVersion: config.serverVersion,
      })
    } catch (err: unknown) {
      setPhase({
        kind: "error",
        message: describeNetworkError(err),
        recoverable: true,
      })
    }
  }, [baseUrl, pairJwt])

  const onSignOut = useCallback(async () => {
    const out = await guard(
      {
        reason: "确认退出当前配对",
        title: "退出登录",
        description: "退出后需重新扫码配对才能再次连接。",
      },
      async () => {
        await clearCompanionConfig()
      }
    )
    if (out.kind === "blocked") {
      if (out.reason !== "cancelled") {
        setPhase({
          kind: "error",
          message: `生物识别失败（${out.reason}），未退出登录。`,
          recoverable: true,
        })
      }
      return
    }
    setBaseUrl("")
    setPairJwt("")
    setServerFingerprint("")
    setPhase({ kind: "idle" })
  }, [guard])

  const onScanQr = useCallback(async () => {
    setPhase({ kind: "idle" })
    const result = await scanBarcode()
    if (result.kind === "scanned") {
      // Try v2 (cgnp2|...) first; v2 carries the TLS fingerprint. Fall back
      // to v1 bare-JSON for backwards compatibility with M3.4 stubs.
      const decoded = decodePairPayload(result.raw)
      if (decoded.kind === "ok") {
        setBaseUrl(decoded.payload.baseUrl)
        setPairJwt(decoded.payload.pairJwt)
        setServerFingerprint(decoded.payload.fingerprint || "")
        setPhase({ kind: "idle" })
        return
      }
      // v1 fallback (bare JSON paste from older builds).
      const legacy = parsePairQrPayload(result.raw)
      if (legacy) {
        setBaseUrl(legacy.baseUrl)
        setPairJwt(legacy.pairJwt)
        setServerFingerprint("")
        setPhase({ kind: "idle" })
        return
      }
      setPhase({
        kind: "error",
        message:
          "QR code scanned but its payload is not a cognia pairing code. Generate a fresh QR from desktop Settings → Companion.",
        recoverable: true,
      })
      return
    }
    if (result.kind === "permission_denied") {
      setPhase({
        kind: "error",
        message:
          "Camera permission denied. Open the system Settings → cognia → Camera to grant access, or paste the pairing code manually.",
        recoverable: true,
      })
      return
    }
    if (result.kind === "unsupported") {
      setPhase({
        kind: "error",
        message:
          "QR scan is only available on the mobile app. Paste the pairing code from desktop Settings → Companion below.",
        recoverable: true,
      })
      return
    }
    if (result.kind === "cancelled") {
      // User backed out — keep the form intact, no error.
      return
    }
    setPhase({
      kind: "error",
      message: `QR scan failed: ${result.message}`,
      recoverable: true,
    })
  }, [])

  const onCallSmoke = useCallback(async () => {
    try {
      const payload = await transport.call(SMOKE_RPC)
      setPhase({ kind: "smoke-call-ok", payload })
    } catch (err: unknown) {
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
        recoverable: true,
      })
    }
  }, [])

  const onSubscribeSmoke = useCallback(() => {
    let lastFrame: unknown = null
    const unsub = transport.subscribe(SMOKE_WS_CHANNEL, (payload) => {
      lastFrame = payload
      setPhase({ kind: "smoke-ws-ok", lastFrame })
    })
    setTimeout(() => {
      unsub()
      setPhase((prev) =>
        prev.kind === "smoke-ws-ok"
          ? prev
          : {
              kind: "smoke-ws-ok",
              lastFrame: lastFrame ?? "(no frame within 5s — connection alone counts as smoke)",
            }
      )
    }, 5000)
  }, [])

  const transportName = transport.constructor.name

  if (phase.kind === "loading") {
    return (
      <main
        className="mx-auto flex min-h-[100dvh] max-w-md items-center justify-center safe-area-py safe-area-px"
        data-testid="pair-onboarding"
      >
        <p className="text-sm text-muted-foreground">Checking for an existing pairing…</p>
      </main>
    )
  }

  return (
    <main
      className="mx-auto flex min-h-[100dvh] max-w-md flex-col gap-4 p-6 safe-area-py safe-area-px"
      data-testid="pair-onboarding"
    >
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">连接桌面</h1>
        <p className="text-sm text-muted-foreground">
          扫一下桌面端的二维码即可完成配对。也可以手动粘贴桌面 Settings → Companion 卡片里的 5
          分钟令牌。
        </p>
      </header>

      {phase.kind === "idle" || phase.kind === "pairing" || phase.kind === "error" ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            void onPair()
          }}
        >
          {/* Primary CTA — scan QR. Big, accessible, top of the form. */}
          <button
            type="button"
            onClick={() => void onScanQr()}
            disabled={phase.kind === "pairing"}
            className="touch-target rounded-xl bg-primary px-6 py-4 text-base font-semibold text-primary-foreground shadow-sm disabled:opacity-60"
            data-testid="pair-scan-qr"
          >
            扫码配对
          </button>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <div className="h-px flex-1 bg-border" />
            <span>或手动粘贴</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">服务器地址</span>
            <input
              className="touch-target rounded-md border border-input bg-background px-3 py-2.5 text-sm"
              type="url"
              inputMode="url"
              placeholder="https://192.168.1.42:7891"
              value={baseUrl}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setBaseUrl(e.target.value)}
              data-testid="pair-baseurl"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">配对令牌</span>
            <textarea
              className="min-h-24 rounded-md border border-input bg-background px-3 py-2.5 font-mono text-xs"
              placeholder="eyJ..."
              value={pairJwt}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setPairJwt(e.target.value)}
              data-testid="pair-jwt"
            />
          </label>

          {serverFingerprint && (
            <div
              className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5 text-xs"
              role="status"
              data-testid="pair-fingerprint-pin"
            >
              <p className="font-medium text-emerald-700 dark:text-emerald-300">✓ 桌面身份已锁定</p>
              <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
                {serverFingerprint.slice(0, 16)}…{serverFingerprint.slice(-16)}
              </p>
            </div>
          )}

          <button
            type="submit"
            disabled={phase.kind === "pairing"}
            className="touch-target rounded-md border border-input px-4 py-2.5 text-sm font-medium disabled:opacity-60"
            data-testid="pair-submit"
          >
            {phase.kind === "pairing" ? "正在配对…" : "完成配对"}
          </button>

          {phase.kind === "error" ? (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
              role="alert"
              data-testid="pair-error"
            >
              {phase.message}
            </p>
          ) : null}

          <p className="text-[11px] text-muted-foreground">
            传输层: <code>{transportName}</code>
          </p>
        </form>
      ) : (
        <section className="flex flex-col gap-3">
          <div className="rounded-md border border-input p-3 text-sm" data-testid="pair-status">
            <p>
              Paired device: <code>{phaseDeviceId(phase)}</code>
            </p>
            <p>
              Server version: <code>{phaseServerVersion(phase)}</code>
            </p>
          </div>

          <button
            type="button"
            onClick={() => void onCallSmoke()}
            className="touch-target rounded-md border border-input px-4 py-2 text-sm"
            data-testid="smoke-call"
          >
            Smoke RPC: {SMOKE_RPC}
          </button>

          <button
            type="button"
            onClick={() => onSubscribeSmoke()}
            className="touch-target rounded-md border border-input px-4 py-2 text-sm"
            data-testid="smoke-ws"
          >
            Smoke WS: subscribe to {SMOKE_WS_CHANNEL} (5s)
          </button>

          <button
            type="button"
            onClick={() => void onSignOut()}
            className="touch-target rounded-md border border-destructive/30 px-4 py-2 text-sm text-destructive"
            data-testid="pair-signout"
          >
            Sign out / re-pair
          </button>

          {phase.kind === "smoke-call-ok" ? (
            <pre
              className="overflow-auto rounded-md bg-muted p-3 text-xs"
              data-testid="smoke-call-result"
            >
              {JSON.stringify(phase.payload, null, 2)}
            </pre>
          ) : null}
          {phase.kind === "smoke-ws-ok" ? (
            <pre
              className="overflow-auto rounded-md bg-muted p-3 text-xs"
              data-testid="smoke-ws-result"
            >
              {JSON.stringify(phase.lastFrame, null, 2)}
            </pre>
          ) : null}
        </section>
      )}
    </main>
  )
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Returns an error string if the URL is not a usable LAN companion server
 * URL, otherwise null. Accepts http or https with an explicit host;
 * rejects empty / non-http / IP-without-host strings.
 */
export function validateBaseUrl(input: string): string | null {
  if (!input) return "Server base URL is required."
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return "Enter a URL like http://192.168.1.42:7890."
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "URL must start with http:// or https://."
  }
  if (!parsed.host) return "URL is missing a host."
  return null
}

/**
 * Returns an error string if the JWT is not shaped like a JWT
 * (`header.payload.signature`, base64url of each part), otherwise null.
 * We don't verify the signature client-side — that's the server's job.
 */
export function validatePairJwt(input: string): string | null {
  if (!input) return "Pair JWT is required."
  const parts = input.split(".")
  if (parts.length !== 3) return "Pair JWT must have three dot-separated parts."
  if (parts.some((p) => p.length === 0)) return "Pair JWT segments must be non-empty."
  if (!parts.every(isBase64Url)) return "Pair JWT must be base64url encoded."
  return null
}

function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value)
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

export function describeHttpError(status: number, body: string): string {
  if (status === 401) {
    return "Pairing code rejected — it may have expired (5-minute lifetime) or already been used. Generate a fresh one in desktop Settings → Companion."
  }
  if (status === 403) {
    return "Server refused the pairing request — check the desktop Companion settings for an allow-list."
  }
  if (status === 404) {
    return "Server doesn't expose /api/v1/auth/pair — confirm the desktop is running cognia v0.2+ with companion enabled."
  }
  if (status >= 500) {
    return `Server error (HTTP ${status}). Check the desktop's logs and try again.`
  }
  return body ? `pair failed (HTTP ${status}): ${body}` : `pair failed (HTTP ${status}).`
}

export function describeNetworkError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/Failed to fetch|NetworkError|ENOTFOUND|ECONNREFUSED/i.test(raw)) {
    return "Could not reach the desktop server. Check the URL, that the desktop has the Companion server enabled, and that both devices are on the same network."
  }
  return raw
}

// ---------------------------------------------------------------------------
// Phase helpers
// ---------------------------------------------------------------------------

function phaseDeviceId(p: Phase): string {
  if (p.kind === "paired") return p.deviceId
  if (p.kind === "smoke-call-ok" || p.kind === "smoke-ws-ok") return "(paired)"
  return "(unknown)"
}

function phaseServerVersion(p: Phase): string {
  if (p.kind === "paired") return p.serverVersion
  return "(unknown)"
}

function getDeviceLabel(): string {
  if (typeof navigator === "undefined") return "unknown-device"
  return navigator.userAgent || "unknown-device"
}

function getDevicePlatform(): string {
  if (typeof window === "undefined") return "unknown"
  const cap = (window as { Capacitor?: { getPlatform?: () => string } }).Capacitor
  if (cap?.getPlatform) {
    return cap.getPlatform()
  }
  return "web"
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ""
  }
}
