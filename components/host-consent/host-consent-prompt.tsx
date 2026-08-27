"use client"

/**
 * The approver's half of a host escalation (ADR-0153).
 *
 * A paired device asking for an admin lease is refused until a human answers
 * here. Mounted on every shell rather than behind `DesktopOnlyInitializers`,
 * because on a headless deployment the host has no screen at all and another
 * paired device IS the only interactive approver there is.
 *
 * ## The frame is a nudge; the list is the truth
 *
 * `host-consent://requested` reaches every subscriber, including the device
 * that asked. What a given device may actually answer is decided by the host
 * — `host_consent_pending` filters out the caller's own asks, and refuses
 * outright for a device without `host.admin`. So every frame triggers a
 * re-read and nothing is rendered from the payload. That also makes the read
 * the capability probe: a refusal renders nothing, which is the correct UI for
 * "you are not the approver".
 *
 * ## Why the operations are shown verbatim
 *
 * The rows list raw command names. Prose would have to summarise what a lease
 * covers, and a summary that drifts from the operation list is worse than an
 * opaque one — the person reading this is deciding whether to hand a device
 * host-admin authority for ten minutes, and the command names are the exact
 * scope of what they are granting.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { ShieldAlertIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  listPendingHostConsent,
  respondToHostConsent,
  subscribeToHostConsent,
  type HostConsentRequest,
} from "@/lib/host-consent/client"
import { getPairedDevice } from "@/lib/db/paired-devices"

export function HostConsentPrompt() {
  const t = useTranslations("hostConsent")
  const [requests, setRequests] = useState<HostConsentRequest[]>([])
  const [label, setLabel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const refresh = useCallback(async () => {
    let open: HostConsentRequest[]
    try {
      open = await listPendingHostConsent()
    } catch {
      // Not an approver, no host, or offline. All three mean the same thing to
      // this surface, and none of them is an error worth showing: the operator
      // did not ask for anything.
      setRequests([])
      return
    }
    setRequests(open)

    const next = open[0]
    if (!next) {
      setLabel(null)
      return
    }
    // Best effort. The paired-devices table lives on whichever shell did the
    // pairing, so an approver phone usually has no row for the asking device
    // and falls back to the id — which is still exact, just unfriendly.
    try {
      setLabel((await getPairedDevice(next.deviceId))?.label ?? null)
    } catch {
      setLabel(null)
    }
  }, [])

  useEffect(() => {
    // A read of the host, not a derivation of props — there is nothing to
    // compute this from, and the state lands a microtask later when the RPC
    // answers. The rule cannot express fetch-on-mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
    return subscribeToHostConsent(() => {
      void refresh()
    })
  }, [refresh])

  const current = requests[0]

  const answer = useCallback(
    async (approve: boolean) => {
      if (!current) return
      setBusy(true)
      setFailed(false)
      try {
        await respondToHostConsent(current.id, approve)
      } catch {
        setFailed(true)
      } finally {
        setBusy(false)
        await refresh()
      }
    },
    [current, refresh]
  )

  if (!current) return null

  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlertIcon className="size-4 text-amber-600 dark:text-amber-500" aria-hidden />
            {t("title")}
          </DialogTitle>
          <DialogDescription>
            {t("description", { device: label ?? current.deviceId })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">{t("operationsLabel")}</p>
            <ul className="space-y-1">
              {current.operations.map((operation) => (
                <li key={operation}>
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{operation}</code>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("codeLabel")} <code className="font-mono">{current.code}</code>
          </p>
          {requests.length > 1 && (
            <p className="text-xs text-muted-foreground">
              {t("more", { count: requests.length - 1 })}
            </p>
          )}
          {failed && (
            <p role="alert" className="text-xs text-destructive">
              {t("failed")}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" onClick={() => void answer(false)} disabled={busy}>
            {t("deny")}
          </Button>
          <Button onClick={() => void answer(true)} disabled={busy}>
            {t("approve")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
