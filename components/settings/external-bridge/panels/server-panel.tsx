"use client"

/**
 * Settings → External Bridge → Server & token.
 *
 * Owns the master enable toggle, the bearer token (show / copy / rotate), and
 * the HTTP port.
 *
 * Three things changed with the master/detail split:
 *  - `tokenRotatedAt` is persisted on every rotation and was never displayed,
 *    so "did I already rotate this?" had no answer in the UI.
 *  - `httpPort` was not editable. Worse, the two readers disagreed on its
 *    default — `startMcpServer` passed `?? 0` (let the OS pick) while the setup
 *    snippet printed `?? 3001`, so before the first successful start the copied
 *    config pointed at a port nothing was listening on.
 *  - The 3 s status poll ran regardless of visibility; it now pauses when the
 *    document is hidden.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { CircleIcon, CopyIcon, KeyRoundIcon, RefreshCwIcon } from "lucide-react"
import { toast } from "sonner"

import { MotionStatusSwap } from "@/components/chat/motion/motion-reveal"
import { SettingsCard } from "@/components/settings/common/settings-section"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useCapability } from "@/hooks/use-host-profile"
import { generateToken } from "@/lib/external-bridge/token"
import {
  getMcpServerStatus,
  restartMcpServer,
  startMcpServer,
  stopMcpServer,
  type McpServerStatus,
} from "@/lib/external-bridge/tauri-control"
import type { ExternalBridgeSettings } from "@/types/wiki"

import { NumberRow } from "../../common/number-row"
import { DEFAULT_BRIDGE_HTTP_PORT, resolveSidecarPath } from "../bridge-runtime"

/** How often the Rust server status is re-read while the panel is visible. */
const STATUS_POLL_MS = 3000

export interface BridgeServerPanelProps {
  settings: ExternalBridgeSettings
  onChange: (next: ExternalBridgeSettings) => void
}

export function BridgeServerPanel({ settings, onChange }: BridgeServerPanelProps) {
  const t = useTranslations("settings.externalBridge")
  const [showToken, setShowToken] = useState(false)
  const [busy, setBusy] = useState(false)
  const [rotateConfirming, setRotateConfirming] = useState(false)
  const [serverStatus, setServerStatus] = useState<McpServerStatus>({
    running: false,
    port: null,
    startedAt: null,
  })
  const hostAvailable = useCapability("mcp-runtime")

  // Poll the Rust HTTP server status so an external `mcp_server_stop` (e.g. the
  // Tauri shutdown handler) is reflected without a reload — but only while the
  // document is visible: a backgrounded settings tab polling forever is pure
  // wakeup cost on a laptop.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const schedule = () => {
      if (cancelled || document.visibilityState === "hidden") return
      timer = setTimeout(refresh, STATUS_POLL_MS)
    }
    const refresh = async () => {
      try {
        const status = await getMcpServerStatus()
        if (!cancelled) setServerStatus(status)
      } catch {
        // swallow — web mode + desktop init races both fall here
      }
      schedule()
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh()
    }

    void refresh()
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [])

  const onToggleEnabled = useCallback(
    async (enabled: boolean) => {
      const next: ExternalBridgeSettings = { ...settings, enabled }
      // Generate a token on first enable so the HTTP transport works out of
      // the box (stdio doesn't need it but the server requires one regardless).
      if (enabled && !next.bearerToken) {
        next.bearerToken = await generateToken()
        next.tokenRotatedAt = Date.now()
      }
      onChange(next)
      // Drive the Rust HTTP server. Web mode silently no-ops via the wrapper.
      if (!hostAvailable) return
      try {
        if (enabled) {
          const sidecarPath = await resolveSidecarPath()
          if (!sidecarPath) {
            // Rust spawns `node <sidecarPath>`; starting with a path that is
            // not there fails inside the child with nothing useful surfaced.
            toast.error(t("server.toastSidecarMissing"))
            onChange({ ...next, enabled: false })
            return
          }
          const port = await startMcpServer({
            port: next.httpPort ?? DEFAULT_BRIDGE_HTTP_PORT,
            token: next.bearerToken!,
            settings: next,
            sidecarPath,
          })
          onChange({ ...next, httpPort: port })
          toast.success(t("server.toastServerStarted", { port }))
        } else {
          await stopMcpServer()
          toast.success(t("server.toastServerStopped"))
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    },
    [settings, onChange, hostAvailable, t]
  )

  const onRotateToken = useCallback(async () => {
    setRotateConfirming(false)
    setBusy(true)
    try {
      const next = await generateToken()
      onChange({ ...settings, bearerToken: next, tokenRotatedAt: Date.now() })
      toast.success(t("server.toastTokenRegenerated"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [settings, onChange, t])

  // Editing the port used to persist and stop there: the listener kept serving
  // the old port with nothing saying so, and the setup snippet immediately
  // started advertising the new one. Restart the running server so the two
  // agree; if the restart fails, `portDiverged` keeps the mismatch visible.
  const onCommitPort = useCallback(
    async (port: number) => {
      const next: ExternalBridgeSettings = { ...settings, httpPort: port }
      onChange(next)
      if (!hostAvailable || !serverStatus.running || !next.bearerToken) return
      if (serverStatus.port === port) return
      const sidecarPath = await resolveSidecarPath()
      if (!sidecarPath) return
      try {
        const bound = await restartMcpServer({
          port,
          token: next.bearerToken,
          settings: next,
          sidecarPath,
        })
        setServerStatus((current) => ({ ...current, running: true, port: bound }))
        if (bound !== port) onChange({ ...next, httpPort: bound })
        toast.success(t("server.toastServerStarted", { port: bound }))
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    },
    [settings, onChange, hostAvailable, serverStatus.running, serverStatus.port, t]
  )

  const onCopyToken = useCallback(async () => {
    if (!settings.bearerToken) return
    await navigator.clipboard.writeText(settings.bearerToken)
    toast.success(t("server.toastTokenCopied"))
  }, [settings.bearerToken, t])

  const statusKey = !hostAvailable ? "web" : serverStatus.running ? "live" : "idle"
  const configuredPort = settings.httpPort ?? DEFAULT_BRIDGE_HTTP_PORT
  const portDiverged =
    serverStatus.running && serverStatus.port !== null && serverStatus.port !== configuredPort

  return (
    <div className="space-y-4">
      <SettingsCard
        icon={<KeyRoundIcon className="size-4" />}
        title={t("server.title")}
        description={
          settings.enabled
            ? serverStatus.running && serverStatus.port !== null
              ? t("server.statusHttpListening", { port: serverStatus.port })
              : t("server.statusStdioActive")
            : t("server.statusOff")
        }
        headerAction={
          <div className="flex items-center gap-2">
            <MotionStatusSwap swapKey={statusKey}>
              <ServerStatusBadge statusKey={statusKey} />
            </MotionStatusSwap>
            <Switch
              checked={settings.enabled}
              onCheckedChange={(v) => void onToggleEnabled(v)}
              aria-label={t("server.toggleAriaLabel")}
            />
          </div>
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <Label className="text-muted-foreground">{t("server.bearerTokenLabel")}</Label>
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded bg-muted px-2 py-0.5 font-mono text-xs break-all">
              {settings.bearerToken
                ? showToken
                  ? settings.bearerToken
                  : "•".repeat(16)
                : t("server.tokenNone")}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowToken((s) => !s)}
              disabled={!settings.bearerToken}
            >
              {showToken ? t("server.hide") : t("server.show")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void onCopyToken()}
              disabled={!settings.bearerToken}
              aria-label={t("server.copyTokenAria")}
            >
              <CopyIcon className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRotateConfirming(true)}
              disabled={busy || !settings.bearerToken}
              aria-label={t("server.rotateTokenAria")}
            >
              <RefreshCwIcon className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {settings.tokenRotatedAt ? (
          <p className="text-xs text-muted-foreground" data-testid="bridge-token-rotated-at">
            {t("server.tokenRotatedAt", {
              time: new Date(settings.tokenRotatedAt).toLocaleString(),
            })}
          </p>
        ) : null}
        {settings.bearerToken && (
          <p className="text-xs text-muted-foreground">{t("server.regenerateWarning")}</p>
        )}

        <NumberRow
          id="bridge-http-port"
          label={t("server.httpPort")}
          help={t("server.httpPortHelp")}
          value={settings.httpPort ?? DEFAULT_BRIDGE_HTTP_PORT}
          // Not 0: an OS-assigned port cannot be written into the client config
          // the setup panel tells the user to paste, which is the whole reason
          // this field has a fixed default.
          min={1}
          max={65535}
          onCommit={(v) => void onCommitPort(v)}
        />
        {portDiverged ? (
          <p
            className="text-xs text-amber-700 dark:text-amber-400"
            data-testid="bridge-port-diverged"
          >
            {t("server.httpPortDiverged", { bound: serverStatus.port ?? 0 })}
          </p>
        ) : null}
      </SettingsCard>

      <AlertDialog open={rotateConfirming} onOpenChange={setRotateConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("server.rotateConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("server.rotateConfirmDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("server.rotateConfirmCancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onRotateToken()}>
              {t("server.rotateConfirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function ServerStatusBadge({ statusKey }: { statusKey: "web" | "live" | "idle" }) {
  const t = useTranslations("settings.externalBridge")
  if (statusKey === "web") {
    return <span className="text-[10px] uppercase text-muted-foreground">{t("badgeWeb")}</span>
  }
  return (
    <span
      className={
        statusKey === "live"
          ? "flex items-center gap-1 text-[10px] uppercase text-emerald-500"
          : "flex items-center gap-1 text-[10px] uppercase text-muted-foreground"
      }
    >
      <CircleIcon className="h-2 w-2 fill-current" />
      {statusKey === "live" ? t("badgeLive") : t("badgeIdle")}
    </span>
  )
}
