"use client"

/**
 * Settings → Remote hosts → Add host (ADR-0082, R0).
 *
 * Pairs this desktop with a remote Cognia host, then registers it in the
 * remote-host store. Reuses the canonical one-shot invitation registration
 * flow and persists the resulting ES256 device identity to
 * the multi-host registry rather than the single-server companion config.
 */

import { useTranslations } from "next-intl"
import { useState } from "react"

import { registerPairPayload } from "@/components/mobile/pair/pair-api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import type { AuthFetcher } from "@/lib/tauri/companion-auth"
import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"
import { LanDiscoveryPanel } from "./lan-discovery-panel"

export interface AddHostTabProps {
  /** Called after a host is successfully paired (e.g. to switch tabs). */
  onPaired?: (host: RemoteHost) => void
  /** Test seam — injected into device registration to avoid the real fetch. */
  fetcher?: AuthFetcher
}

export function AddHostTab({ onPaired, fetcher }: AddHostTabProps) {
  const t = useTranslations("settings.remoteHosts")
  const addHost = useRemoteHostStore((s) => s.addHost)
  const activateHost = useRemoteHostStore((s) => s.activateHost)

  const [payload, setPayload] = useState("")
  const [label, setLabel] = useState("")
  const [connectAfter, setConnectAfter] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  async function onSubmit() {
    setError(null)
    setSuccess(null)
    const trimmedPayload = payload.trim()
    if (!trimmedPayload) {
      setError(t("add.errMissing"))
      return
    }

    setBusy(true)
    try {
      const result = await registerPairPayload(trimmedPayload, fetcher)
      if (result.kind === "ok") {
        const host = addHost({ label: label.trim() || undefined, config: result.config })
        if (connectAfter) activateHost(host.id)
        setSuccess(t("add.success", { label: host.label }))
        setPayload("")
        setLabel("")
        onPaired?.(host)
      } else {
        setError(t(result.kind === "invalid_payload" ? "add.errPayload" : "add.errGeneric"))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="remote-host-payload">{t("add.payloadLabel")}</Label>
        <Textarea
          id="remote-host-payload"
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          placeholder={t("add.payloadPlaceholder")}
          rows={3}
          spellCheck={false}
          className="font-mono text-xs"
        />
        <p className="text-xs text-muted-foreground">{t("add.payloadHint")}</p>
      </div>

      <LanDiscoveryPanel payload={payload} onUseAddress={setPayload} />

      <div className="space-y-1.5">
        <Label htmlFor="remote-host-label">{t("add.labelLabel")}</Label>
        <Input
          id="remote-host-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t("add.labelPlaceholder")}
        />
      </div>

      <div className="flex items-center justify-between rounded-md border p-3">
        <Label htmlFor="remote-host-connect-after" className="cursor-pointer">
          {t("add.connectAfter")}
        </Label>
        <Switch
          id="remote-host-connect-after"
          checked={connectAfter}
          onCheckedChange={setConnectAfter}
        />
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {success ? (
        <p role="status" className="text-sm text-emerald-600 dark:text-emerald-400">
          {success}
        </p>
      ) : null}

      <Button onClick={onSubmit} disabled={busy}>
        {busy ? t("add.submitting") : t("add.submit")}
      </Button>
    </div>
  )
}
