"use client"

/**
 * This device asks another one to approve it (protocol §5.2, new device's
 * side). While the panel is open it checks its own request every few
 * seconds; the six-digit code appears only after this device revealed its
 * nonce, and completing accepts only what the verified list proves.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { SmartphoneIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import type { AccountSyncContext } from "@/lib/account-sync/enrollment/context"
import {
  cancelJoin,
  completeJoin,
  pollJoin,
  startJoin,
  type JoinProgress,
  type JoinRequest,
} from "@/lib/account-sync/enrollment/join"
import { currentDevicePlatform, suggestDeviceName } from "@/lib/account-sync/enrollment/platform"

import { explainSyncError } from "./explain-sync-error"

export const JOIN_POLL_MS = 3_000

export interface JoinRequestPanelProps {
  context: AccountSyncContext
  onDone: () => void
}

function minutesLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 60_000))
}

export function JoinRequestPanel({ context, onDone }: JoinRequestPanelProps) {
  const t = useTranslations("accountSync")
  const [name, setName] = useState(() => suggestDeviceName())
  const [join, setJoin] = useState<JoinRequest | null>(null)
  const [progress, setProgress] = useState<JoinProgress | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const completing = useRef(false)
  // The translator and the callback take new identities on renders; the poll must not restart with them.
  const tRef = useRef(t)
  const onDoneRef = useRef(onDone)
  useEffect(() => {
    tRef.current = t
    onDoneRef.current = onDone
  })

  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      setJoin(await startJoin(context, { name, platform: currentDevicePlatform() }))
      setProgress({ phase: "waiting" })
    } catch (cause) {
      setError(explainSyncError(t, cause))
    } finally {
      setBusy(false)
    }
  }

  // Polls while a request is open; a phase change (code shown, approved) does not restart it.
  const open = !!join && progress?.phase !== "ended"
  useEffect(() => {
    if (!join || !open) return
    let cancelled = false
    const tick = async () => {
      setNow(Date.now())
      try {
        const next = await pollJoin(context, join)
        if (cancelled) return
        setProgress(next)
        if (next.phase === "approved" && !completing.current) {
          completing.current = true
          await completeJoin(context, join)
          if (!cancelled) {
            toast.success(tRef.current("join.done"))
            onDoneRef.current()
          }
        }
      } catch (cause) {
        if (!cancelled) setError(explainSyncError(tRef.current, cause))
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), JOIN_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [context, join, open])

  const cancel = async () => {
    if (!join) return
    try {
      await cancelJoin(context, join)
      setProgress({ phase: "ended", reason: "cancelled" })
    } catch (cause) {
      setError(explainSyncError(t, cause))
    }
  }

  const restart = () => {
    completing.current = false
    setJoin(null)
    setProgress(null)
    setError(null)
  }

  return (
    <div
      className="flex flex-col gap-3"
      data-testid="account-sync-join"
      data-phase={progress?.phase ?? "start"}
    >
      {!join ? (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-sync-join-name" className="text-xs">
              {t("setup.nameLabel")}
            </Label>
            <Input
              id="account-sync-join-name"
              value={name}
              placeholder={t("devices.unnamed")}
              maxLength={40}
              onChange={(event) => setName(event.target.value)}
              data-testid="account-sync-join-name"
            />
          </div>
          <Button
            type="button"
            size="sm"
            className="self-start"
            disabled={busy}
            onClick={() => void start()}
            data-testid="account-sync-join-start"
          >
            <SmartphoneIcon data-icon="inline-start" />
            {busy ? t("section.working") : t("join.askApproval")}
          </Button>
        </>
      ) : progress?.phase === "ended" ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm" role="status" data-testid="account-sync-join-ended">
            {t(`join.ended.${progress.reason}`)}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="self-start"
            onClick={restart}
            data-testid="account-sync-join-again"
          >
            {t("join.tryAgain")}
          </Button>
        </div>
      ) : progress?.phase === "approved" ? (
        <p className="flex items-center gap-2 text-sm" role="status">
          <Spinner className="size-3" />
          {t("join.approved")}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {progress?.phase === "code" ? (
            <>
              <p className="text-xs text-muted-foreground">{t("join.code")}</p>
              <p
                className="font-mono text-3xl font-semibold tracking-[0.2em]"
                data-testid="account-sync-join-code"
              >
                {progress.code}
              </p>
            </>
          ) : (
            <p className="flex items-center gap-2 text-sm" role="status">
              <Spinner className="size-3" />
              {t("join.waiting")}
            </p>
          )}
          <p className="text-[11px] text-muted-foreground">
            {t("join.expiresIn", { minutes: minutesLeft(join.expiresAt, now) })}
          </p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="self-start"
            onClick={() => void cancel()}
            data-testid="account-sync-join-cancel"
          >
            {t("join.cancel")}
          </Button>
        </div>
      )}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
