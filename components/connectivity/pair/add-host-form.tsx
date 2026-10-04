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
 *
 * # Who owns the invitation field
 *
 * `PairStep` does: it holds the text and reports every change through
 * `onPayloadChange`. This form keeps a read-only copy of what the user has
 * entered (for the LAN panel's stale-address cross-check, which until now was
 * handed this form's own copy and so never saw a single pasted character), and
 * writes the field only when the user explicitly takes the LAN panel's live
 * address. That write is a remount with a fresh `seed`, keyed by a nonce: the
 * old `key={payload}` remounted the step on every change of a value the step
 * itself was editing, which threw away whatever had been typed.
 *
 * Connecting after pairing is a host switch, so it goes through the shared
 * in-flight guard (`useExecutionHostSwitch`), and `onPaired` waits for that
 * answer: the add-host sheet closes on `onPaired`, and closing it first would
 * unmount the confirmation dialog it renders.
 */

import { useCallback, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"

import { LoopbackDiscoveryPanel } from "@/components/settings/remote-hosts/loopback-discovery-panel"
import { LanDiscoveryPanel } from "@/components/settings/remote-hosts/tabs/lan-discovery-panel"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useExecutionHostSwitch } from "@/hooks/devices/use-execution-host-switch"
import { isNativeMobile, isTauri } from "@/lib/platform/detect"
import type { CompanionConfig } from "@/lib/tauri/transport-companion"
import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"

import { PairStep, type PairStepProps } from "./pair-step"

/** The shell never changes under a running page, so there is nothing to subscribe to. */
const subscribeNothing = () => () => undefined
const serverNotNative = () => false

/**
 * Whether the camera scanner works here. `scan()` is the Capacitor ML Kit
 * plugin (`lib/capacitor/barcode.ts`), which answers `unsupported` on Tauri
 * and in a browser: there is no webcam decoder in this app. Read through
 * `useSyncExternalStore` so the static export's server snapshot (never
 * native) and the first client render agree.
 */
export function useScanAvailable(): boolean {
  return useSyncExternalStore(subscribeNothing, isNativeMobile, serverNotNative)
}

export interface AddHostFormProps {
  /** Called after a host is successfully registered (e.g. to close a sheet). */
  onPaired?: (host: RemoteHost) => void
  /**
   * The host a caller is adding, e.g. `/servers` handing over a controller's
   * public URL. Shown as context only. It is deliberately NOT put into the
   * invitation field: pairing redeems a signed `cgnp<N>|…` invitation, a URL is
   * not one, and pre-filling it made every submit fail as `wrong_format`.
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
  const { requestSwitch, dialog } = useExecutionHostSwitch()
  const scanAvailable = useScanAvailable()

  /** What the field holds right now, as reported by the step. Read-only here. */
  const [observedPayload, setObservedPayload] = useState("")
  /** The last value this form WROTE into the field, and the remount that wrote it. */
  const [seed, setSeed] = useState<{ payload: string; nonce: number }>({ payload: "", nonce: 0 })
  const [label, setLabel] = useState("")
  const [connectAfter, setConnectAfter] = useState(true)
  const [success, setSuccess] = useState<string | null>(null)

  const lane = discoveryLane ?? (isTauri() ? "mdns" : "loopback")

  // Taking the live address is the one explicit write: the user asked for the
  // field to change, so remounting the step with the rewritten invitation is
  // what they expect, and nothing they typed is lost because the rewrite is
  // derived from it.
  const takeLiveAddress = useCallback((nextPayload: string) => {
    setSeed((current) => ({ payload: nextPayload, nonce: current.nonce + 1 }))
    setObservedPayload(nextPayload)
  }, [])

  // The registry write is the "persist" half of the shared step: a companion
  // pairing saves the config as THIS device's Host, a registry pairing files
  // it under a label and may activate it. `PairStep` reports the config again
  // through `onPaired`, which is where the success line and the caller run.
  const persistPairing = useCallback(
    async (config: CompanionConfig) => {
      const host = addHost({ label: label.trim() || undefined, config })
      setSuccess(t("add.success", { label: host.label }))
      setLabel("")
      if (!connectAfter) {
        onPaired?.(host)
        return
      }
      // Fire-and-forget on purpose. The pairing itself succeeded the moment
      // `addHost` returned; whether this window also starts driving the host
      // is a separate question the user may still be answering, and holding
      // `persistPairing` open on it would keep the pair step's spinner turning
      // over a dialog.
      void requestSwitch(host.id, { onSettled: () => onPaired?.(host) })
    },
    [addHost, connectAfter, label, onPaired, requestSwitch, t]
  )

  return (
    <div className="space-y-4" data-testid="add-host-form" data-discovery-lane={lane}>
      {initialBaseUrl ? (
        <p className="text-xs text-muted-foreground" data-testid="add-host-seeded-url">
          {t("add.seededFrom", { url: initialBaseUrl })}
        </p>
      ) : null}

      {/* Discovery informs the invitation, so it sits above it. The label and
          "connect after" ride inside the pair form: below the submit button
          they read as a second step after "Complete pairing" had already
          run with whatever they held. */}
      {lane === "mdns" ? (
        <LanDiscoveryPanel payload={observedPayload} onUseAddress={takeLiveAddress} />
      ) : (
        <LoopbackDiscoveryPanel />
      )}

      <PairStep
        key={seed.nonce}
        prefilledPairPayload={seed.payload}
        webMode
        allowScan={scanAvailable}
        onPayloadChange={setObservedPayload}
        persistPairing={persistPairing}
        onPaired={() => undefined}
        extraFields={
          <>
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
          </>
        }
        {...pairStepProps}
      />

      {success ? (
        <p role="status" className="text-sm text-success" data-testid="add-host-success">
          {success}
        </p>
      ) : null}
      {dialog}
    </div>
  )
}
