"use client"

/**
 * The desktop owner's answer to "let this paired device into this project's
 * Pro IDE".
 *
 * The desktop's workbench runs code-server without a password and with full
 * terminals, because only this machine can reach it. Relaying it to a paired
 * device hands that device the same terminals, so the host asks here, once
 * per device and project; the approval lasts until it is revoked in
 * Settings → Pro IDE. Desktop-only: the answer is the owner's gesture at this
 * machine, and the commands behind it are local by contract.
 *
 * The event is a nudge and the pending list is the truth, as in
 * `HostConsentPrompt`: every frame triggers a re-read.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { SquareTerminalIcon } from "lucide-react"

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
  CODESERVER_EVENTS,
  codeServerClient,
  type CodeServerRelayGrantRequest,
} from "@/lib/codeserver/client"
import { getPairedDevice } from "@/lib/db/paired-devices"
import { isTauri } from "@/lib/tauri"
import { onTauriEvent } from "@/lib/tauri/events"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

const projectName = (root: string) =>
  root
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || root

export function CodeServerRelayGrantPrompt() {
  const t = useTranslations("projectEditor.proIde.relayGrant")
  const [requests, setRequests] = useState<CodeServerRelayGrantRequest[]>([])
  const [label, setLabel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const refresh = useCallback(async () => {
    let open: CodeServerRelayGrantRequest[]
    try {
      open = await codeServerClient.relayGrantPending()
    } catch {
      setRequests([])
      return
    }
    setRequests(open)
    const next = open[0]
    if (!next) {
      setLabel(null)
      return
    }
    try {
      setLabel((await getPairedDevice(next.deviceId))?.label ?? null)
    } catch {
      setLabel(null)
    }
  }, [])

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let unlisten: (() => void) | null = null
    // Fetch-on-mount: asks raised before this mounted are only in the list.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
    void onTauriEvent(CODESERVER_EVENTS.relayGrantRequested, () => {
      if (!cancelled) void refresh()
    }).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    })
    return () => {
      cancelled = true
      safeUnlisten(unlisten)
    }
  }, [refresh])

  const current = requests[0]

  const answer = useCallback(
    async (approve: boolean) => {
      if (!current) return
      setBusy(true)
      setFailed(false)
      try {
        await codeServerClient.relayGrantRespond(current.id, approve)
      } catch {
        // Expired or already answered; the re-read below drops it.
        setFailed(true)
      } finally {
        setBusy(false)
        await refresh()
      }
    },
    [current, refresh]
  )

  if (!current) return null

  const device = label ?? current.deviceId
  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md"
        data-testid="code-server-relay-grant-prompt"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SquareTerminalIcon className="size-4 text-amber-600 dark:text-amber-500" aria-hidden />
            {t("title")}
          </DialogTitle>
          <DialogDescription>
            {t("description", { device, project: projectName(current.root) })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">{t("risk")}</p>
          <p className="text-xs text-muted-foreground">
            {t("folderLabel")} <code className="font-mono break-all">{current.root}</code>
          </p>
          <p className="text-xs text-muted-foreground">{t("lasting")}</p>
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
