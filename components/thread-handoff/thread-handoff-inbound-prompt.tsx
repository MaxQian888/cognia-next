"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { AlertTriangleIcon, ArrowRightLeftIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useEffect, useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Surface } from "@/components/surface/surface"
import { getDb } from "@/lib/db/schema"
import { isCapacitor } from "@/lib/platform/detect"
import { isStandaloneChatMode } from "@/lib/runtime/standalone-mode"
import { transport } from "@/lib/tauri"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
import { ThreadHandoffClient } from "@/lib/thread-handoff/client"
import {
  THREAD_HANDOFF_OFFER_CHANNEL,
  type ThreadHandoffOfferFrame,
} from "@/lib/thread-handoff/orchestrator"
import {
  completeInboundThreadHandoff,
  prepareInboundThreadHandoff,
  resumeAcceptedThreadHandoff,
  type PreparedInboundThreadHandoff,
} from "@/lib/thread-handoff/standalone-receiver"
import type { ThreadHandoffTicket } from "@cognia/agent-config-types/thread-handoff"

export interface ThreadHandoffInboundPromptProps {
  prepared?: PreparedInboundThreadHandoff | null
  recovery?: ThreadHandoffTicket | null
  busy?: boolean
  failed?: boolean
  onAccept: () => void
  onDecline?: () => void
}

export function ThreadHandoffInboundPrompt({
  prepared,
  recovery,
  busy = false,
  failed = false,
  onAccept,
  onDecline,
}: ThreadHandoffInboundPromptProps) {
  const t = useTranslations("threadHandoff.inbound")
  const ticket = prepared?.ticket ?? recovery
  if (!ticket) return null
  const blockers = prepared?.preflight.blockers ?? []
  const blocked = prepared ? !prepared.preflight.ok : false
  const degraded = blockers.filter((blocker) => blocker.severity === "degraded")

  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeftIcon className="size-4" aria-hidden />
            {recovery ? t("recoveryTitle") : t("title")}
          </DialogTitle>
          <DialogDescription>
            {recovery
              ? t("recoveryDescription", { title: ticket.source.title })
              : t("description", { title: ticket.source.title })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <p>{t("permissionReset")}</p>
          {/* Only a preflight can report a downgrade. The recovery path has no
              `prepared`, and comparing its absent fidelity against the ticket's
              rendered this warning on every resume with an undefined value. */}
          {prepared && prepared.preflight.achievableFidelity !== ticket.continuation.fidelity ? (
            <Surface asChild layer="raised" radius="control">
              <p className="border border-amber-500/40 bg-amber-500/10 p-3">
                {t("fidelityLoss", { fidelity: prepared.preflight.achievableFidelity })}
              </p>
            </Surface>
          ) : null}
          {blockers.length > 0 ? (
            <ul className="space-y-1 rounded-md border p-3" aria-label={t("blockersLabel")}>
              {blockers.map((blocker) => (
                <li key={`${blocker.kind}:${blocker.ref}`} className="flex gap-2">
                  <AlertTriangleIcon
                    className={
                      blocker.severity === "blocking"
                        ? "mt-0.5 size-4 text-destructive"
                        : "mt-0.5 size-4 text-amber-600"
                    }
                    aria-hidden
                  />
                  <span>{t(`blocker.${blocker.kind}`, { ref: blocker.ref })}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {degraded.length > 0 ? <p>{t("degradedHint")}</p> : null}
          {failed ? <p className="text-sm text-destructive">{t("failed")}</p> : null}
        </div>

        <DialogFooter>
          {onDecline ? (
            <Button variant="outline" disabled={busy} onClick={onDecline}>
              {t("decline")}
            </Button>
          ) : null}
          <Button disabled={busy || blocked} onClick={onAccept}>
            {busy ? t("working") : recovery ? t("resume") : t("accept")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ThreadHandoffInboundPromptProvider() {
  const [prepared, setPrepared] = useState<PreparedInboundThreadHandoff | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const recoveryTickets = useLiveQuery(
    () =>
      getDb()
        .threadHandoffTickets.filter(
          (ticket) => ticket.role === "target" && ticket.state === "accepted"
        )
        .toArray(),
    []
  )
  const recovery = useMemo(
    () => recoveryTickets?.sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null,
    [recoveryTickets]
  )

  useEffect(() => {
    if (!isCapacitor() || !isStandaloneChatMode()) return
    return transport.subscribe<ThreadHandoffOfferFrame>(THREAD_HANDOFF_OFFER_CHANNEL, (frame) => {
      const deviceId = loadCompanionConfig()?.deviceId
      if (!deviceId) return
      void prepareInboundThreadHandoff(frame, deviceId)
        .then((next) => {
          if (next) setPrepared(next)
        })
        .catch(() => setFailed(true))
    })
  }, [])

  const accept = async () => {
    setBusy(true)
    setFailed(false)
    try {
      if (prepared) await completeInboundThreadHandoff(prepared)
      else if (recovery) await resumeAcceptedThreadHandoff(recovery)
      setPrepared(null)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const decline = prepared
    ? async () => {
        setBusy(true)
        setFailed(false)
        try {
          await new ThreadHandoffClient().abort(prepared.ticket.ticketId, "source", "not-accepted")
          setPrepared(null)
        } catch {
          setFailed(true)
        } finally {
          setBusy(false)
        }
      }
    : undefined

  return (
    <ThreadHandoffInboundPrompt
      prepared={prepared}
      recovery={recovery}
      busy={busy}
      failed={failed}
      onAccept={() => void accept()}
      onDecline={decline ? () => void decline() : undefined}
    />
  )
}
