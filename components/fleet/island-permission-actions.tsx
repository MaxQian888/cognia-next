"use client"

/**
 * IslandPermissionActions — Approve/Deny controls for a parked permission
 * request, with a live countdown of the island's answer window. After the
 * window lapses the Rust side fails open (the agent's own terminal prompt
 * takes over), so the buttons disable rather than lie about control.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { fleetPermissionRespond } from "@/lib/tauri/fleet"
import { FLEET_PERMISSION_WAIT_MS, type PendingPermission } from "@/lib/fleet/types"
import { cn } from "@/lib/utils"

export function IslandPermissionActions({
  pending,
  className,
}: {
  pending: PendingPermission
  className?: string
}) {
  const t = useTranslations("fleet.permission")
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [answering, setAnswering] = useState(false)
  const [answered, setAnswered] = useState<"allow" | "deny" | null>(null)

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const remainingSec = useMemo(() => {
    const deadline = pending.requestedAt + FLEET_PERMISSION_WAIT_MS
    return Math.max(0, Math.ceil((deadline - nowMs) / 1000))
  }, [pending.requestedAt, nowMs])

  const expired = remainingSec <= 0
  // Fraction of the answer window left — drives the draining progress bar.
  // The 1s tick quantizes it; the linear width transition bridges the steps.
  const remainingFraction = Math.min(
    1,
    Math.max(0, (remainingSec * 1000) / FLEET_PERMISSION_WAIT_MS)
  )

  const respond = async (behavior: "allow" | "deny") => {
    if (answering || answered || expired) return
    setAnswering(true)
    try {
      const ok = await fleetPermissionRespond(pending.requestId, behavior)
      if (ok) setAnswered(behavior)
    } finally {
      setAnswering(false)
    }
  }

  return (
    <div data-testid="island-permission-actions" className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[11px] text-amber-300">
          {pending.toolName ? t("request", { tool: pending.toolName }) : t("requestGeneric")}
          {pending.detail ? <span className="text-white/50"> {pending.detail}</span> : null}
        </span>
        {answered ? (
          <span className="text-[11px] text-white/60" data-testid="permission-answered">
            {t(answered === "allow" ? "allowed" : "denied")}
          </span>
        ) : expired ? (
          <span className="text-[11px] text-white/40" data-testid="permission-expired">
            {t("expired")}
          </span>
        ) : (
          <>
            <span
              className="text-[10px] tabular-nums text-white/40"
              data-testid="permission-countdown"
            >
              {t("countdown", { seconds: remainingSec })}
            </span>
            <button
              type="button"
              data-testid="permission-allow"
              disabled={answering}
              onClick={() => void respond("allow")}
              className="rounded-md bg-emerald-500/90 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-emerald-400 disabled:opacity-50"
            >
              {t("allow")}
            </button>
            <button
              type="button"
              data-testid="permission-deny"
              disabled={answering}
              onClick={() => void respond("deny")}
              className="rounded-md bg-red-500/80 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-red-400 disabled:opacity-50"
            >
              {t("deny")}
            </button>
          </>
        )}
      </div>
      {!answered && !expired ? (
        <div
          className="h-0.5 w-full overflow-hidden rounded-full bg-white/10"
          data-testid="permission-progress-track"
          aria-hidden
        >
          <div
            data-testid="permission-progress"
            className={cn(
              "h-full rounded-full transition-[width] duration-1000 ease-linear motion-reduce:transition-none",
              remainingSec <= 5 ? "bg-red-400" : "bg-amber-400"
            )}
            style={{ width: `${remainingFraction * 100}%` }}
          />
        </div>
      ) : null}
    </div>
  )
}

export default IslandPermissionActions
