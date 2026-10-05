"use client"

/**
 * Approving a new device (protocol §5.2, approver's side), opened from the
 * notification, the device list or the devices console. The request is
 * captured when the person continues; the code is shown only after the new
 * device revealed a nonce matching its commitment; "the codes match" adds
 * it, "they differ" turns it down.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import {
  beginApproval,
  confirmApproval,
  denyRequest,
  pollApproval,
  type Approval,
  type ApprovalProgress,
  type IncomingRequest,
} from "@/lib/account-sync/enrollment/approve"
import { useAccountSyncStore } from "@/stores/account-sync/account-sync-store"

import { explainSyncError } from "./explain-sync-error"

export const APPROVAL_POLL_MS = 2_000

type Phase = "review" | "waiting" | "code" | "ended"

export function ApproveDeviceDialog() {
  const requestId = useAccountSyncStore((state) => state.approvalRequestId)
  const close = useAccountSyncStore((state) => state.closeApproval)
  return (
    <Dialog open={requestId !== null} onOpenChange={(open) => !open && close()}>
      {/* Keyed by request: another request starts from a clean slate. */}
      {requestId ? <ApprovalFlow key={requestId} requestId={requestId} /> : null}
    </Dialog>
  )
}

function ApprovalFlow({ requestId }: { requestId: string }) {
  const t = useTranslations("accountSync")
  const incoming = useAccountSyncStore((state) => state.incoming)
  const context = useAccountSyncStore((state) => state.context)
  const view = useAccountSyncStore((state) => state.view)
  const close = useAccountSyncStore((state) => state.closeApproval)
  const requestRefresh = useAccountSyncStore((state) => state.requestRefresh)

  const [captured, setCaptured] = useState<IncomingRequest | null>(null)
  const [approval, setApproval] = useState<Approval | null>(null)
  const [phase, setPhase] = useState<Phase>("review")
  const [code, setCode] = useState<string | null>(null)
  const [ended, setEnded] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  // The translator takes a new identity on renders; the poll must not restart with it.
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  })

  const device = view.kind === "enrolled" ? view.device : null
  const request = captured ?? incoming.find((item) => item.requestId === requestId) ?? null

  useEffect(() => {
    if (!approval || !context || !device || phase !== "waiting") return
    let cancelled = false
    const tick = async () => {
      setNow(Date.now())
      try {
        const progress: ApprovalProgress = await pollApproval(context, device, approval)
        if (cancelled) return
        if (progress.phase === "code") {
          setCode(progress.code)
          setPhase("code")
        } else if (progress.phase === "ended") {
          const tr = tRef.current
          setEnded(
            progress.reason === "approved"
              ? tr("approve.notFound")
              : tr(`join.ended.${progress.reason}`)
          )
          setPhase("ended")
        }
      } catch (cause) {
        if (!cancelled) {
          setEnded(explainSyncError(tRef.current, cause))
          setPhase("ended")
        }
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), APPROVAL_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [approval, context, device, phase])

  const name = request?.displayName || t("approve.unknownName")
  const platform = request ? t(`devices.platform.${request.platform}`) : ""

  const act = async (operation: () => Promise<void>) => {
    setBusy(true)
    try {
      await operation()
    } catch (cause) {
      toast.error(explainSyncError(t, cause))
    } finally {
      setBusy(false)
    }
  }

  const begin = () =>
    act(async () => {
      if (!context || !device || !request) return
      setCaptured(request)
      setApproval(await beginApproval(context, device, request))
      setPhase("waiting")
    })

  const deny = (reason: "denied" | "mismatch") =>
    act(async () => {
      if (!context || !device || !request) return
      await denyRequest(context, device, request.requestId, reason, approval ?? undefined)
      requestRefresh()
      close()
    })

  const confirm = () =>
    act(async () => {
      if (!context || !device || !approval) return
      await confirmApproval(context, device, approval)
      toast.success(t("approve.added", { name }))
      requestRefresh()
      close()
    })

  const minutes = request ? Math.max(0, Math.ceil((request.expiresAt - now) / 60_000)) : 0

  return (
    <DialogContent className="sm:max-w-md" data-testid="approve-device-dialog" data-phase={phase}>
      <DialogHeader>
        <DialogTitle>{t("approve.title")}</DialogTitle>
        {request ? (
          <DialogDescription>{t("approve.description", { name, platform })}</DialogDescription>
        ) : null}
      </DialogHeader>

      {!request || !device ? (
        <p className="text-sm" data-testid="approve-device-not-found">
          {t("approve.notFound")}
        </p>
      ) : phase === "ended" ? (
        <p className="text-sm" role="status" data-testid="approve-device-ended">
          {ended}
        </p>
      ) : phase === "waiting" ? (
        <p className="flex items-center gap-2 text-sm" role="status">
          <Spinner className="size-3" />
          {t("approve.waitingReveal")}
        </p>
      ) : phase === "code" ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">{t("approve.codePrompt")}</p>
          <p
            className="font-mono text-3xl font-semibold tracking-[0.2em]"
            data-testid="approve-device-code"
          >
            {code}
          </p>
        </div>
      ) : null}

      {request && device && phase !== "ended" ? (
        <p className="text-[11px] text-muted-foreground">{t("approve.expiresIn", { minutes })}</p>
      ) : null}

      <DialogFooter>
        {request && device && phase === "review" ? (
          <>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => void deny("denied")}
              data-testid="approve-device-deny"
            >
              {t("approve.deny")}
            </Button>
            <Button
              type="button"
              disabled={busy}
              onClick={() => void begin()}
              data-testid="approve-device-continue"
            >
              {t("approve.continue")}
            </Button>
          </>
        ) : request && device && phase === "code" ? (
          <>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => void deny("mismatch")}
              data-testid="approve-device-mismatch"
            >
              {t("approve.mismatch")}
            </Button>
            <Button
              type="button"
              disabled={busy}
              onClick={() => void confirm()}
              data-testid="approve-device-match"
            >
              {t("approve.match")}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="outline"
            onClick={close}
            data-testid="approve-device-close"
          >
            {t("approve.close")}
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  )
}
