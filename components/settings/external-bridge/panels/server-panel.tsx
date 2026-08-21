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
import { BanIcon, CircleIcon, CopyIcon, KeyRoundIcon, RefreshCwIcon } from "lucide-react"
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
import { issueHostAdminLease } from "@/lib/tauri/admin-lease"
import {
  createExternalBridgeClient,
  getExternalBridgeConfig,
  getExternalBridgeStatus,
  getMcpServerStatus,
  isHostManagedBridgeAvailable,
  listExternalBridgeClients,
  restartExternalBridge,
  restartMcpServer,
  revokeExternalBridgeClient,
  rotateExternalBridgeClient,
  startExternalBridge,
  startMcpServer,
  stopExternalBridge,
  stopMcpServer,
  updateExternalBridgeConfig,
  type McpServerStatus,
} from "@/lib/external-bridge/tauri-control"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
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
  const [revokeConfirming, setRevokeConfirming] = useState(false)
  const [oneTimeCredential, setOneTimeCredential] = useState<string | null>(null)
  const [serverStatus, setServerStatus] = useState<McpServerStatus>({
    running: false,
    port: null,
    startedAt: null,
  })
  const hostAvailable = useCapability("mcp-runtime")
  const remoteHostActive = isRemoteHostActive()
  const hostManaged = remoteHostActive && isHostManagedBridgeAvailable()
  const bridgeAvailable = remoteHostActive ? hostManaged : hostAvailable

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
        if (hostManaged) {
          const status = await getExternalBridgeStatus()
          if (!cancelled) {
            setServerStatus({
              running: status.state === "running",
              port: status.endpoint ? Number(new URL(status.endpoint).port) : null,
              startedAt: status.startedAt ?? null,
            })
          }
        } else {
          const status = await getMcpServerStatus()
          if (!cancelled) setServerStatus(status)
        }
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
  }, [hostManaged])

  const onToggleEnabled = useCallback(
    async (enabled: boolean) => {
      const next: ExternalBridgeSettings = { ...settings, enabled }
      // Generate a token on first enable so the HTTP transport works out of
      // the box (stdio doesn't need it but the server requires one regardless).
      if (enabled && !hostManaged && !next.bearerToken) {
        next.bearerToken = await generateToken()
        next.tokenRotatedAt = Date.now()
      }
      onChange(next)
      // Drive the Rust HTTP server. Web mode silently no-ops via the wrapper.
      if (!bridgeAvailable) return
      try {
        if (enabled) {
          if (hostManaged) {
            const lease = await issueHostAdminLease([
              "external_bridge_config_update",
              "external_bridge_client_create",
              "external_bridge_start",
            ])
            let config = await getExternalBridgeConfig()
            const desiredPort = next.httpPort ?? DEFAULT_BRIDGE_HTTP_PORT
            if (
              config.port !== desiredPort ||
              config.enabledScopes.join("\0") !== next.enabledScopes.join("\0")
            ) {
              config = await updateExternalBridgeConfig(
                {
                  expectedRevision: config.revision,
                  enabledScopes: next.enabledScopes,
                  port: desiredPort,
                  bindMode: "loopback",
                  autoStart: config.autoStart,
                },
                lease.token
              )
            }
            const clients = await listExternalBridgeClients()
            if (!clients.some((client) => !client.revokedAt)) {
              const created = await createExternalBridgeClient(
                {
                  name: t("server.defaultClientName"),
                  scopes: config.enabledScopes,
                },
                lease.token
              )
              setOneTimeCredential(created.credential)
            }
            const port = await startExternalBridge(lease.token)
            onChange({ ...next, httpPort: port })
            toast.success(t("server.toastServerStarted", { port }))
            return
          }
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
          if (hostManaged) {
            const lease = await issueHostAdminLease(["external_bridge_stop"])
            await stopExternalBridge(lease.token)
          } else await stopMcpServer()
          toast.success(t("server.toastServerStopped"))
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    },
    [settings, onChange, bridgeAvailable, hostManaged, t]
  )

  const onRotateToken = useCallback(async () => {
    setRotateConfirming(false)
    setBusy(true)
    try {
      if (hostManaged) {
        const client = (await listExternalBridgeClients()).find((candidate) => !candidate.revokedAt)
        if (!client) throw new Error(t("server.noActiveClientError"))
        const lease = await issueHostAdminLease(["external_bridge_client_rotate"])
        const rotated = await rotateExternalBridgeClient(client.id, lease.token)
        setOneTimeCredential(rotated.credential)
        toast.success(t("server.toastTokenRegenerated"))
        return
      }
      const next = await generateToken()
      onChange({ ...settings, bearerToken: next, tokenRotatedAt: Date.now() })
      toast.success(t("server.toastTokenRegenerated"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [settings, onChange, hostManaged, t])

  /**
   * Kill switch for a leaked credential.
   *
   * Rotation issues a replacement and is what you reach for on a schedule;
   * revocation ends the grant outright and is what you reach for when the
   * credential is in someone else's hands. Rust already answered both
   * (`external_bridge_client_revoke` closes the client's live sessions via
   * `replace_bridge_clients`), and `ExternalBridgeClient.revokedAt` was
   * already read here to pick the active client — only the way to *produce*
   * that state was missing.
   *
   * Host-managed mode only: the local MCP path has a single bearer token with
   * no client identity to revoke, and there rotation already invalidates the
   * old value.
   */
  const onRevokeClient = useCallback(async () => {
    setRevokeConfirming(false)
    setBusy(true)
    try {
      const client = (await listExternalBridgeClients()).find((candidate) => !candidate.revokedAt)
      if (!client) throw new Error(t("server.noActiveClientError"))
      const lease = await issueHostAdminLease(["external_bridge_client_revoke"])
      await revokeExternalBridgeClient(client.id, lease.token)
      // The plaintext shown after create/rotate belongs to the grant that just
      // ended — keeping it on screen would invite pasting a dead credential.
      setOneTimeCredential(null)
      setShowToken(false)
      toast.success(t("server.toastClientRevoked", { name: client.name }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [t])

  // Editing the port used to persist and stop there: the listener kept serving
  // the old port with nothing saying so, and the setup snippet immediately
  // started advertising the new one. Restart the running server so the two
  // agree; if the restart fails, `portDiverged` keeps the mismatch visible.
  const onCommitPort = useCallback(
    async (port: number) => {
      const next: ExternalBridgeSettings = { ...settings, httpPort: port }
      onChange(next)
      if (!bridgeAvailable || !serverStatus.running) return
      if (serverStatus.port === port) return
      if (hostManaged) {
        try {
          const lease = await issueHostAdminLease([
            "external_bridge_config_update",
            "external_bridge_restart",
          ])
          const config = await getExternalBridgeConfig()
          await updateExternalBridgeConfig(
            {
              expectedRevision: config.revision,
              enabledScopes: next.enabledScopes,
              port,
              bindMode: "loopback",
              autoStart: config.autoStart,
            },
            lease.token
          )
          const bound = await restartExternalBridge(lease.token)
          setServerStatus((current) => ({ ...current, running: true, port: bound }))
          if (bound !== port) onChange({ ...next, httpPort: bound })
          toast.success(t("server.toastServerStarted", { port: bound }))
        } catch {
          toast.error(t("server.toastRestartFailed"))
        }
        return
      }
      if (!next.bearerToken) return
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
    [settings, onChange, bridgeAvailable, hostManaged, serverStatus.running, serverStatus.port, t]
  )

  const onCopyToken = useCallback(async () => {
    const credential = hostManaged ? oneTimeCredential : settings.bearerToken
    if (!credential) return
    await navigator.clipboard.writeText(credential)
    toast.success(t("server.toastTokenCopied"))
  }, [hostManaged, oneTimeCredential, settings.bearerToken, t])

  const statusKey = !bridgeAvailable ? "web" : serverStatus.running ? "live" : "idle"
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
              {(hostManaged ? oneTimeCredential : settings.bearerToken)
                ? showToken
                  ? hostManaged
                    ? oneTimeCredential
                    : settings.bearerToken
                  : "•".repeat(16)
                : t("server.tokenNone")}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowToken((s) => !s)}
              disabled={!(hostManaged ? oneTimeCredential : settings.bearerToken)}
            >
              {showToken ? t("server.hide") : t("server.show")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void onCopyToken()}
              disabled={!(hostManaged ? oneTimeCredential : settings.bearerToken)}
              aria-label={t("server.copyTokenAria")}
            >
              <CopyIcon className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRotateConfirming(true)}
              disabled={busy || (hostManaged ? false : !settings.bearerToken)}
              aria-label={t("server.rotateTokenAria")}
            >
              <RefreshCwIcon className="h-3.5 w-3.5" />
            </Button>
            {/* Host-managed only — see `onRevokeClient`. */}
            {hostManaged ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setRevokeConfirming(true)}
                disabled={busy}
                aria-label={t("server.revokeClientAria")}
                data-testid="bridge-revoke-client"
              >
                <BanIcon className="h-3.5 w-3.5" />
              </Button>
            ) : null}
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

      <AlertDialog open={revokeConfirming} onOpenChange={setRevokeConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("server.revokeConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("server.revokeConfirmDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("server.revokeConfirmCancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onRevokeClient()}>
              {t("server.revokeConfirmAction")}
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
