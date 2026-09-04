"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { AlertTriangleIcon, CheckIcon, SmartphoneIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import type { ChatSession } from "@cognia/agent-config-types"

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
import { listPairedDevices } from "@/lib/db/paired-devices"
import { getThreadHandoffTicket } from "@/lib/db/thread-handoff-tickets"
import { getDb } from "@/lib/db/schema"
import { recoverThreadHandoffOffer, startThreadHandoff } from "@/lib/thread-handoff/orchestrator"
import type { PairedDeviceRow } from "@/types/mobile/paired-device"

export type ThreadHandoffTargetUnavailableReason =
  "revoked" | "paused" | "not-mobile" | "standalone-required"

export function threadHandoffTargetUnavailableReason(
  device: PairedDeviceRow
): ThreadHandoffTargetUnavailableReason | null {
  if (device.revokedAt) return "revoked"
  if (device.pausedAt) return "paused"
  if (device.platform !== "ios" && device.platform !== "android") return "not-mobile"
  if (!device.capabilities?.includes("thread-handoff-v1")) return "standalone-required"
  return null
}

export interface ThreadHandoffSourceDialogProps {
  session: ChatSession
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ThreadHandoffSourceDialog({
  session,
  open,
  onOpenChange,
}: ThreadHandoffSourceDialogProps) {
  const t = useTranslations("threadHandoff.source")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const snapshot = useLiveQuery(async () => {
    const devices = await listPairedDevices()
    const ticket = session.handoffLock
      ? await getThreadHandoffTicket(session.handoffLock.ticketId, "source")
      : undefined
    const dispatch = session.handoffLock
      ? await getDb().hostDispatchQueue.get(session.handoffLock.ticketId)
      : undefined
    return { devices, ticket, dispatch }
  }, [session.handoffLock?.ticketId])
  const devices = useMemo(() => snapshot?.devices ?? [], [snapshot?.devices])
  const eligible = useMemo(
    () => devices.filter((device) => threadHandoffTargetUnavailableReason(device) === null),
    [devices]
  )
  const selected = eligible.find((device) => device.deviceId === selectedId) ?? eligible[0]
  const locked = Boolean(session.handoffLock)

  const start = async () => {
    if (!selected) return
    setBusy(true)
    try {
      await startThreadHandoff(session, {
        hostRef: selected.deviceId,
        kind: "mobile",
        label: selected.label,
      })
      toast.success(t("started"))
      onOpenChange(false)
    } catch {
      toast.error(t("failed"))
    } finally {
      setBusy(false)
    }
  }

  const retry = async () => {
    if (!session.handoffLock || !snapshot?.ticket) return
    setBusy(true)
    try {
      if (snapshot.dispatch) {
        await getDb().hostDispatchQueue.update(snapshot.dispatch.id, {
          status: "pending",
          attempts: 0,
          nextAttemptAt: Date.now(),
          updatedAt: Date.now(),
          terminalCode: undefined,
          lastError: undefined,
        })
      } else {
        await recoverThreadHandoffOffer(session, snapshot.ticket)
      }
      toast.success(t("retryQueued"))
    } catch {
      toast.error(t("failed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{locked ? t("statusTitle") : t("title")}</DialogTitle>
          <DialogDescription>
            {locked
              ? t("statusDescription", { state: snapshot?.ticket?.state ?? "frozen" })
              : t("description")}
          </DialogDescription>
        </DialogHeader>

        {locked ? (
          <div className="space-y-3 text-sm">
            <Surface asChild layer="raised" radius="control">
              <p className="border border-amber-500/40 bg-amber-500/10 p-3">
                {session.handoffLock?.state === "committed"
                  ? t("committedReadonly")
                  : t("frozenReadonly")}
              </p>
            </Surface>
            {!snapshot?.dispatch ||
            snapshot.dispatch.status === "deadletter" ||
            snapshot?.dispatch?.status === "failed" ? (
              <p className="flex gap-2 text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-4" aria-hidden />
                {t("stranded")}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-2">
            {devices.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noDevices")}</p>
            ) : (
              devices.map((device) => {
                const reason = threadHandoffTargetUnavailableReason(device)
                const selectedDevice = selected?.deviceId === device.deviceId
                return (
                  <button
                    key={device.deviceId}
                    type="button"
                    disabled={reason !== null}
                    onClick={() => setSelectedId(device.deviceId)}
                    className="flex w-full items-start gap-3 rounded-md border p-3 text-left disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    <SmartphoneIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{device.label}</span>
                      <span className="block text-xs text-muted-foreground">
                        {reason ? t(`unavailable.${reason}`) : t("available")}
                      </span>
                    </span>
                    {selectedDevice ? <CheckIcon className="size-4" aria-hidden /> : null}
                  </button>
                )
              })
            )}
            <p className="text-xs text-muted-foreground">{t("lossDisclosure")}</p>
          </div>
        )}

        <DialogFooter>
          {locked &&
          session.handoffLock?.state === "frozen" &&
          snapshot?.ticket &&
          snapshot?.dispatch?.status !== "succeeded" ? (
            <Button disabled={busy} onClick={() => void retry()}>
              {t("retry")}
            </Button>
          ) : !locked ? (
            <Button disabled={busy || !selected} onClick={() => void start()}>
              {busy ? t("starting") : t("continue")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
