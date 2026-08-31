"use client"

/**
 * The pair-a-remote-host form, extracted from `tabs/add-host-tab.tsx` so the
 * `/devices` console can offer the same flow without a second implementation
 * or a trip to Settings.
 *
 * Two things changed in the move, both about reach:
 *
 *  * **Discovery is per-shell, not per-section.** mDNS is the only genuinely
 *    desktop-only part, so the gate sits on the panel rather than on the whole
 *    surface. A browser gets `LoopbackDiscoveryPanel` instead, which probes
 *    the one address a tab can actually reach.
 *  * **The keyring can refuse.** Off Tauri the credential vault is an
 *    AES-GCM IndexedDB store that throws while the browser vault is locked.
 *    Pairing that "succeeds" and then loses its device identity is worse than
 *    one that says the vault is locked, so the throw is surfaced verbatim
 *    rather than folded into the generic failure.
 */

import { useTranslations } from "next-intl"
import { useState } from "react"

import { registerPairPayload } from "@/components/mobile/pair/pair-api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { isTauri } from "@/lib/platform/detect"
import type { AuthFetcher } from "@/lib/tauri/companion-auth"
import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"

import { LoopbackDiscoveryPanel } from "./loopback-discovery-panel"
import { LanDiscoveryPanel } from "./tabs/lan-discovery-panel"

export interface AddHostFormProps {
  /** Called after a host is successfully paired (e.g. to switch tabs). */
  onPaired?: (host: RemoteHost) => void
  /** Test seam. Injected into device registration to avoid the real fetch. */
  fetcher?: AuthFetcher
  /**
   * Seeds the payload field, e.g. from `/servers` handing over a controller's
   * public URL. Only a hint: the invitation still has to be pasted, and this
   * is deliberately not a second way to name a host.
   */
  initialBaseUrl?: string
  /**
   * Force the discovery lane instead of detecting it. Only tests and
   * Storybook pass this.
   */
  discoveryLane?: "mdns" | "loopback"
}

export function AddHostForm({
  onPaired,
  fetcher,
  initialBaseUrl,
  discoveryLane,
}: AddHostFormProps) {
  const t = useTranslations("settings.remoteHosts")
  const addHost = useRemoteHostStore((s) => s.addHost)
  const activateHost = useRemoteHostStore((s) => s.activateHost)

  const [payload, setPayload] = useState("")
  const [label, setLabel] = useState("")
  const [connectAfter, setConnectAfter] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const lane = discoveryLane ?? (isTauri() ? "mdns" : "loopback")

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
    } catch (cause) {
      // Reaches here when the credential vault refuses the write. Saying so
      // beats "Pairing failed", which sends the user back to the host to
      // regenerate an invitation that was never the problem.
      setError(cause instanceof Error ? cause.message : t("add.errGeneric"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4" data-testid="add-host-form" data-discovery-lane={lane}>
      <div className="space-y-1.5">
        <Label htmlFor="remote-host-payload">{t("add.payloadLabel")}</Label>
        <Textarea
          id="remote-host-payload"
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          placeholder={initialBaseUrl ?? t("add.payloadPlaceholder")}
          rows={3}
          spellCheck={false}
          className="font-mono text-xs"
        />
        <p className="text-xs text-muted-foreground">{t("add.payloadHint")}</p>
        {initialBaseUrl ? (
          <p className="text-xs text-muted-foreground" data-testid="add-host-seeded-url">
            {t("add.seededFrom", { url: initialBaseUrl })}
          </p>
        ) : null}
      </div>

      {lane === "mdns" ? (
        <LanDiscoveryPanel payload={payload} onUseAddress={setPayload} />
      ) : (
        <LoopbackDiscoveryPanel />
      )}

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
        <p role="status" className="text-sm text-success">
          {success}
        </p>
      ) : null}

      <Button onClick={onSubmit} disabled={busy}>
        {busy ? t("add.submitting") : t("add.submit")}
      </Button>
    </div>
  )
}
