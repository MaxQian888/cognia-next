"use client"

/**
 * Connectivity → Network drive → the host's own WebDAV/SFTP listener
 * (ADR-0222 §7.3): whether it serves, who can reach it (this computer, the
 * local network, or the internet through a cloudflared tunnel), on which
 * ports, and where it answers right now.
 *
 * The listener only ever serves what a live grant gives a credential, so
 * turning it on exposes nothing by itself. The draft starts from the host's
 * config; the panel remounts this block when the host answers with a new one.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { CopyValue } from "@/components/filespace/live-share-credentials"
import { SettingsBlock, SettingsField } from "@/components/settings/common/settings-block"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import {
  fileShareErrorDetails,
  setFileShareListener,
  type FileShareTarget,
} from "@/lib/filespace/grants-client"
import type {
  LiveExposure,
  LiveListenerConfig,
  LiveListenerStatus,
  LiveTunnelMode,
} from "@/types/filespace/live"

const EXPOSURES: readonly LiveExposure[] = ["loopback", "lan", "tunnel"]
const TUNNEL_MODES: readonly LiveTunnelMode[] = ["quick", "named"]

/** What keeps a draft from being sent, or `null`. */
export function listenerDraftProblem(
  draft: LiveListenerConfig
): "noProtocol" | "invalidPorts" | null {
  if (!draft.webdav && !draft.sftp) return "noProtocol"
  const valid = (port: number) => Number.isInteger(port) && port >= 1024 && port <= 65535
  if (!valid(draft.webdavPort) || !valid(draft.sftpPort)) return "invalidPorts"
  if (draft.webdav && draft.sftp && draft.webdavPort === draft.sftpPort) return "invalidPorts"
  return null
}

export interface NetworkDriveBlockProps {
  listener: LiveListenerStatus
  target: FileShareTarget
  onSaved: () => void
}

export function NetworkDriveBlock({ listener, target, onSaved }: NetworkDriveBlockProps) {
  const t = useTranslations("liveShare.settings.listener")
  const tl = useTranslations("liveShare")
  const [draft, setDraft] = useState<LiveListenerConfig>(listener.config)
  const [token, setToken] = useState("")
  const [saving, setSaving] = useState(false)
  const running = listener.webdavPort !== null || listener.sftpPort !== null
  const dirty = JSON.stringify(draft) !== JSON.stringify(listener.config) || token !== ""
  const problem = listenerDraftProblem(draft)
  const edit = (patch: Partial<LiveListenerConfig>) =>
    setDraft((current) => ({ ...current, ...patch }))

  const save = async () => {
    setSaving(true)
    try {
      await setFileShareListener(
        {
          ...draft,
          tunnelHostname: draft.tunnelHostname?.trim() || null,
          ...(token.trim() ? { tunnelToken: token.trim() } : {}),
        },
        target
      )
      toast.success(t("saved"))
      onSaved()
    } catch (error) {
      const { code, message } = fileShareErrorDetails(error)
      toast.error(tl(`errors.${code}`, { message }))
    } finally {
      setSaving(false)
    }
  }

  const port = (key: "webdavPort" | "sftpPort", protocol: string) => (
    <Input
      id={`network-drive-${key}`}
      type="number"
      inputMode="numeric"
      min={1024}
      max={65535}
      className="w-28"
      value={Number.isNaN(draft[key]) ? "" : String(draft[key])}
      aria-label={t("port", { protocol })}
      onChange={(event) => edit({ [key]: Number.parseInt(event.target.value, 10) })}
    />
  )

  return (
    <SettingsBlock
      title={t("title")}
      description={t("description")}
      testid="network-drive-block"
      badge={
        <Badge variant={running ? "secondary" : "outline"} className="text-[10px]">
          {running ? t("running") : t("stopped")}
        </Badge>
      }
    >
      <SettingsField htmlFor="network-drive-enabled" label={t("enabled")}>
        <Switch
          id="network-drive-enabled"
          checked={draft.enabled}
          onCheckedChange={(enabled) => edit({ enabled })}
        />
      </SettingsField>

      <SettingsField label={t("exposure.label")} stacked>
        <RadioGroup
          value={draft.exposure}
          onValueChange={(next) => edit({ exposure: next as LiveExposure })}
          className="gap-2"
        >
          {EXPOSURES.map((exposure) => (
            <div key={exposure} className="flex items-start gap-2">
              <RadioGroupItem
                id={`network-drive-exposure-${exposure}`}
                value={exposure}
                className="mt-0.5"
              />
              <div className="space-y-0.5">
                <Label
                  htmlFor={`network-drive-exposure-${exposure}`}
                  className="text-sm font-normal"
                >
                  {t(`exposure.${exposure}`)}
                </Label>
                <p className="text-xs text-muted-foreground">{t(`exposure.${exposure}Hint`)}</p>
              </div>
            </div>
          ))}
        </RadioGroup>
      </SettingsField>

      <SettingsField htmlFor="network-drive-webdav" label={tl("dialog.protocol.webdav")}>
        <div className="flex items-center gap-3">
          {port("webdavPort", tl("dialog.protocol.webdav"))}
          <Switch
            id="network-drive-webdav"
            checked={draft.webdav}
            onCheckedChange={(webdav) => edit({ webdav })}
          />
        </div>
      </SettingsField>
      <SettingsField htmlFor="network-drive-sftp" label={tl("dialog.protocol.sftp")}>
        <div className="flex items-center gap-3">
          {port("sftpPort", tl("dialog.protocol.sftp"))}
          <Switch
            id="network-drive-sftp"
            checked={draft.sftp}
            onCheckedChange={(sftp) => edit({ sftp })}
          />
        </div>
      </SettingsField>

      {draft.exposure === "tunnel" ? (
        <SettingsField label={t("tunnel.mode")} stacked>
          <RadioGroup
            value={draft.tunnelMode}
            onValueChange={(next) => edit({ tunnelMode: next as LiveTunnelMode })}
            className="gap-2"
          >
            {TUNNEL_MODES.map((mode) => (
              <div key={mode} className="flex items-start gap-2">
                <RadioGroupItem
                  id={`network-drive-tunnel-${mode}`}
                  value={mode}
                  className="mt-0.5"
                />
                <div className="space-y-0.5">
                  <Label htmlFor={`network-drive-tunnel-${mode}`} className="text-sm font-normal">
                    {t(`tunnel.${mode}`)}
                  </Label>
                  <p className="text-xs text-muted-foreground">{t(`tunnel.${mode}Hint`)}</p>
                </div>
              </div>
            ))}
          </RadioGroup>
          {draft.tunnelMode === "named" ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="network-drive-tunnel-hostname">{t("tunnel.hostname")}</Label>
                <Input
                  id="network-drive-tunnel-hostname"
                  value={draft.tunnelHostname ?? ""}
                  placeholder={
                    /* i18n-exempt: an example hostname, identical in every language */ "files.example.com"
                  }
                  onChange={(event) => edit({ tunnelHostname: event.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="network-drive-tunnel-token">{t("tunnel.token")}</Label>
                <Input
                  id="network-drive-tunnel-token"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                />
                {listener.tunnelTokenSet ? (
                  <p className="text-xs text-muted-foreground">{t("tunnel.tokenSet")}</p>
                ) : null}
              </div>
            </div>
          ) : null}
        </SettingsField>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        {problem ? (
          <p className="text-xs text-destructive" role="alert">
            {t(problem)}
          </p>
        ) : null}
        <Button
          type="button"
          size="sm"
          disabled={!dirty || problem !== null || saving}
          onClick={() => void save()}
        >
          {saving ? t("saving") : t("save")}
        </Button>
      </div>

      {listener.errors.length > 0 ? (
        <div className="space-y-1" data-testid="network-drive-errors">
          <p className="text-xs font-medium">{t("problems")}</p>
          {listener.errors.map((error) => (
            <p key={`${error.component}:${error.message}`} className="text-xs text-destructive">
              {error.component}: {error.message}
            </p>
          ))}
        </div>
      ) : null}

      {running ? (
        <div className="space-y-1" data-testid="network-drive-addresses">
          <p className="text-xs font-medium">{t("addresses")}</p>
          {listener.tunnelUrl ? (
            <CopyValue label={t("publicUrl")} value={listener.tunnelUrl} />
          ) : null}
          {listener.endpoints.webdavUrls.map((url) => (
            <CopyValue key={url} label={tl("dialog.protocol.webdav")} value={url} />
          ))}
          {listener.endpoints.sftp.map((endpoint) => (
            <CopyValue
              key={`${endpoint.host}:${endpoint.port}`}
              label={tl("dialog.protocol.sftp")}
              value={`${endpoint.host}:${endpoint.port}`}
            />
          ))}
          {listener.endpoints.sftpHostKeyFingerprint ? (
            <CopyValue
              label={tl("credentials.hostKey")}
              value={listener.endpoints.sftpHostKeyFingerprint}
            />
          ) : null}
          {listener.endpoints.tlsFingerprint ? (
            <CopyValue label={tl("credentials.tls")} value={listener.endpoints.tlsFingerprint} />
          ) : null}
        </div>
      ) : null}
    </SettingsBlock>
  )
}
