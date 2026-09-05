"use client"

/**
 * Pair a remote host into this device's registry, on any shell.
 *
 * The form every "Add host" entry point mounts: Settings → Connectivity →
 * Remote hosts, and the `/devices` console's sheet. It is the same `PairStep`
 * the phone and the browser `/pair` route use, so an invitation is redeemed
 * one way everywhere, relay fallback included (ADR-0170). What this form adds
 * is what a registry entry needs and a companion pairing does not: a label,
 * whether to drive the host straight away, and a discovery panel that fills
 * the invitation with a live address.
 *
 * Off Tauri the credential vault can refuse the write while the browser vault
 * is locked. `PairStep` surfaces that as its own failure with an unlock
 * action, which beats a pairing that "succeeds" and then loses its identity.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"

import { LoopbackDiscoveryPanel } from "@/components/settings/remote-hosts/loopback-discovery-panel"
import { LanDiscoveryPanel } from "@/components/settings/remote-hosts/tabs/lan-discovery-panel"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { isTauri } from "@/lib/platform/detect"
import type { CompanionConfig } from "@/lib/tauri/transport-companion"
import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"

import { PairStep, type PairStepProps } from "./pair-step"

export interface AddHostFormProps {
  /** Called after a host is successfully registered (e.g. to close a sheet). */
  onPaired?: (host: RemoteHost) => void
  /**
   * Seeds the invitation field, e.g. from `/servers` handing over a
   * controller's public URL. Only a hint: the invitation still has to be
   * pasted, and this is deliberately not a second way to name a host.
   */
  initialBaseUrl?: string
  /** Force the discovery lane instead of detecting it. Tests and Storybook. */
  discoveryLane?: "mdns" | "loopback"
  /** Test seams forwarded to the shared pair step. */
  pairStepProps?: Pick<PairStepProps, "isCredentialStoreReady" | "onRequestUnlock">
}

export function AddHostForm({
  onPaired,
  initialBaseUrl,
  discoveryLane,
  pairStepProps,
}: AddHostFormProps) {
  const t = useTranslations("settings.remoteHosts")
  const addHost = useRemoteHostStore((s) => s.addHost)
  const activateHost = useRemoteHostStore((s) => s.activateHost)

  const [payload, setPayload] = useState(initialBaseUrl ?? "")
  const [label, setLabel] = useState("")
  const [connectAfter, setConnectAfter] = useState(true)
  const [success, setSuccess] = useState<string | null>(null)

  const lane = discoveryLane ?? (isTauri() ? "mdns" : "loopback")

  // The registry write is the "persist" half of the shared step: a companion
  // pairing saves the config as THIS device's Host, a registry pairing files
  // it under a label and may activate it. `PairStep` reports the config again
  // through `onPaired`, which is where the success line and the caller run.
  const persistPairing = useCallback(
    async (config: CompanionConfig) => {
      const host = addHost({ label: label.trim() || undefined, config })
      if (connectAfter) activateHost(host.id)
      setSuccess(t("add.success", { label: host.label }))
      setLabel("")
      onPaired?.(host)
    },
    [activateHost, addHost, connectAfter, label, onPaired, t]
  )

  return (
    <div className="space-y-4" data-testid="add-host-form" data-discovery-lane={lane}>
      {initialBaseUrl ? (
        <p className="text-xs text-muted-foreground" data-testid="add-host-seeded-url">
          {t("add.seededFrom", { url: initialBaseUrl })}
        </p>
      ) : null}

      <PairStep
        key={payload}
        prefilledPairPayload={payload}
        webMode
        persistPairing={persistPairing}
        onPaired={() => undefined}
        {...pairStepProps}
      />

      {lane === "mdns" ? (
        <LanDiscoveryPanel payload={payload} onUseAddress={setPayload} />
      ) : (
        <LoopbackDiscoveryPanel onUseAddress={setPayload} />
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

      <div className="flex items-center justify-between rounded-md border border-border/60 p-3">
        <Label htmlFor="remote-host-connect-after" className="cursor-pointer">
          {t("add.connectAfter")}
        </Label>
        <Switch
          id="remote-host-connect-after"
          checked={connectAfter}
          onCheckedChange={setConnectAfter}
        />
      </div>

      {success ? (
        <p role="status" className="text-sm text-success" data-testid="add-host-success">
          {success}
        </p>
      ) : null}
    </div>
  )
}
