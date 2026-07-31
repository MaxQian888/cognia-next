"use client"

/**
 * Settings → Remote hosts → Add host (ADR-0082, R0).
 *
 * Pairs this desktop with a remote Cognia host, then registers it in the
 * remote-host store. Reuses the pure pairing surface — `decodePairPayload`
 * (accepts a `cgnp2|…` payload or a raw pair JWT), the `validate*` helpers,
 * and `redeemPairJwt` (which pins the host's TLS fingerprint) — and persists to
 * the multi-host registry rather than the single-server companion config.
 */

import { useTranslations } from "next-intl"
import { useState } from "react"

import { redeemPairJwt, type PairFetcher } from "@/components/mobile/pair/pair-api"
import { validateBaseUrl, validatePairJwt } from "@/components/mobile/pair/pair-helpers"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { decodePairPayload } from "@/lib/qr/pair-payload"
import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"

export interface AddHostTabProps {
  /** Called after a host is successfully paired (e.g. to switch tabs). */
  onPaired?: (host: RemoteHost) => void
  /** Test seam — injected into `redeemPairJwt` to avoid the real fetch. */
  fetcher?: PairFetcher
}

export function AddHostTab({ onPaired, fetcher }: AddHostTabProps) {
  const t = useTranslations("settings.remoteHosts")
  const addHost = useRemoteHostStore((s) => s.addHost)
  const activateHost = useRemoteHostStore((s) => s.activateHost)

  const [baseUrl, setBaseUrl] = useState("")
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

    let baseUrlToUse = baseUrl.trim()
    let pairJwt: string
    let fingerprint: string | undefined

    const decoded = decodePairPayload(trimmedPayload)
    if (decoded.kind === "ok") {
      pairJwt = decoded.payload.pairJwt
      fingerprint = decoded.payload.fingerprint
      if (decoded.payload.baseUrl) baseUrlToUse = decoded.payload.baseUrl
    } else {
      // Not a cgnp payload → treat the text as a raw pair JWT (needs a URL).
      if (validatePairJwt(trimmedPayload) !== null) {
        setError(t("add.errPayload"))
        return
      }
      pairJwt = trimmedPayload
    }

    if (validateBaseUrl(baseUrlToUse) !== null) {
      setError(t("add.errBaseUrl"))
      return
    }

    setBusy(true)
    try {
      const result = await redeemPairJwt(
        { baseUrl: baseUrlToUse, pairJwt, serverFingerprint: fingerprint },
        fetcher
      )
      if (result.kind === "ok") {
        const host = addHost({ label: label.trim() || undefined, config: result.config })
        if (connectAfter) activateHost(host.id)
        setSuccess(t("add.success", { label: host.label }))
        setPayload("")
        setBaseUrl("")
        setLabel("")
        onPaired?.(host)
      } else if (result.kind === "network_error") {
        setError(t("add.errNetwork"))
      } else if (result.kind === "http_error") {
        setError(t("add.errHttp", { status: result.status }))
      } else {
        setError(t("add.errGeneric"))
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

      <div className="space-y-1.5">
        <Label htmlFor="remote-host-baseurl">{t("add.baseUrlLabel")}</Label>
        <Input
          id="remote-host-baseurl"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={t("add.baseUrlPlaceholder")}
          inputMode="url"
          autoCapitalize="none"
          spellCheck={false}
        />
        <p className="text-xs text-muted-foreground">{t("add.baseUrlHint")}</p>
      </div>

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
