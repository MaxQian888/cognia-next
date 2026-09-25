"use client"

/**
 * IslandPermissionActions — the inline decision for a pending ask: a tool
 * permission, a plan step, spending past a budget, or another durable run
 * approval.
 *
 * A countdown renders only for an ask that actually lapses. A hook-based CLI
 * holds its ask for a short window and then hands the prompt back to the
 * agent's own terminal; a durable run approval expires at its deadline; a
 * conversation's or an ACP agent's ask waits for the person. Counting down an
 * ask that never lapses disabled the buttons while it was still live.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useNowTicker } from "@/hooks/fleet/use-now-ticker"
import { fleetPermissionRespond } from "@/lib/tauri/fleet"
import { answerWindow, formatRemaining } from "@/lib/fleet/format"
import { FLEET_PERMISSION_WAIT_MS, type PendingPermission } from "@/lib/fleet/types"
import type {
  IslandAnswerDeadline,
  IslandDecisionBehavior,
  IslandDecisionKind,
} from "@/lib/island/types"
import { cn } from "@/lib/utils"

/** The attention panel's fleet rows: a hook ask, answered by the direct Tauri command. */
const answerThroughHook = (requestId: string, behavior: IslandDecisionBehavior) =>
  fleetPermissionRespond(requestId, behavior === "deny" ? "deny" : "allow")

export function IslandPermissionActions({
  pending,
  kind = "tool",
  deadline,
  allowAlways = false,
  className,
  respond: respondVia = answerThroughHook,
}: {
  pending: PendingPermission
  kind?: IslandDecisionKind
  /**
   * When the ask stops waiting. Omitted means the hook ingress window counted
   * from `pending.requestedAt`; `null` means it waits for the person.
   */
  deadline?: IslandAnswerDeadline | null
  /** Offer "Always allow", which also records a standing rule. */
  allowAlways?: boolean
  className?: string
  /**
   * How the decision actually travels. Defaults to the direct Tauri command,
   * which is what the main window's Attention panel wants. The island window
   * injects an intent dispatcher instead, because it holds no business
   * permissions of its own.
   */
  respond?: (requestId: string, behavior: IslandDecisionBehavior) => Promise<boolean>
}) {
  const t = useTranslations("fleet.permission")
  // Countdown ticks off the shared fleet ticker (one interval for the whole
  // island + attention panel) rather than a per-card `setInterval`.
  const nowMs = useNowTicker()
  const [answering, setAnswering] = useState(false)
  const [answered, setAnswered] = useState<IslandDecisionBehavior | null>(null)

  const lapse: IslandAnswerDeadline | null =
    deadline === undefined
      ? { at: pending.requestedAt + FLEET_PERMISSION_WAIT_MS, fallback: "terminal" }
      : deadline
  const countdown = lapse ? answerWindow(pending.requestedAt, lapse.at, nowMs) : null
  const expired = countdown?.expired ?? false
  // A tool ask is allowed or denied; every other decision is approved or rejected.
  const verbs = kind === "tool" ? { yes: "allow", no: "deny" } : { yes: "approve", no: "reject" }

  const respond = async (behavior: IslandDecisionBehavior) => {
    if (answering || answered || expired) return
    setAnswering(true)
    try {
      const ok = await respondVia(pending.requestId, behavior)
      if (ok) setAnswered(behavior)
    } finally {
      setAnswering(false)
    }
  }

  const prompt =
    kind === "tool"
      ? pending.toolName
        ? t("request", { tool: pending.toolName })
        : t("requestGeneric")
      : t(`ask.${kind}`)

  return (
    <div
      data-testid="island-permission-actions"
      data-kind={kind}
      className={cn("flex flex-col gap-1", className)}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[11px] text-amber-300">
          {prompt}
          {pending.detail ? <span className="text-white/50"> {pending.detail}</span> : null}
        </span>
        {answered ? (
          <span className="text-[11px] text-white/60" data-testid="permission-answered">
            {answered === "allow_always"
              ? t("allowedAlways")
              : t(answered === "deny" ? `answered.${verbs.no}` : `answered.${verbs.yes}`)}
          </span>
        ) : expired && lapse ? (
          <span className="text-[11px] text-white/40" data-testid="permission-expired">
            {t(lapse.fallback === "terminal" ? "expired" : "lapsed")}
          </span>
        ) : (
          <>
            {countdown ? (
              <span
                className="text-[10px] tabular-nums text-white/40"
                data-testid="permission-countdown"
              >
                {t("remaining", { duration: formatRemaining(countdown.remainingSec) })}
              </span>
            ) : null}
            {allowAlways ? (
              <button
                type="button"
                data-testid="permission-allow-always"
                disabled={answering}
                onClick={() => void respond("allow_always")}
                className="rounded-md bg-white/10 px-2 py-0.5 text-[11px] font-medium text-emerald-200 hover:bg-white/20 disabled:opacity-50"
              >
                {t("allowAlways")}
              </button>
            ) : null}
            <button
              type="button"
              data-testid="permission-allow"
              disabled={answering}
              onClick={() => void respond("allow")}
              className="rounded-md bg-emerald-500/90 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-emerald-400 disabled:opacity-50"
            >
              {t(verbs.yes)}
            </button>
            <button
              type="button"
              data-testid="permission-deny"
              disabled={answering}
              onClick={() => void respond("deny")}
              className="rounded-md bg-red-500/80 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-red-400 disabled:opacity-50"
            >
              {t(verbs.no)}
            </button>
          </>
        )}
      </div>
      {countdown && !answered && !expired ? (
        <div
          className="h-0.5 w-full overflow-hidden rounded-full bg-white/10"
          data-testid="permission-progress-track"
          aria-hidden
        >
          <div
            data-testid="permission-progress"
            className={cn(
              "h-full rounded-full transition-[width] duration-1000 ease-linear motion-reduce:transition-none",
              countdown.urgent ? "bg-red-400" : "bg-amber-400"
            )}
            style={{ width: `${countdown.fraction * 100}%` }}
          />
        </div>
      ) : null}
    </div>
  )
}

export default IslandPermissionActions
