"use client"

/**
 * SessionDetail — the expandable per-session detail block for an island row.
 * Surfaces the otherwise-dormant DTO fields (full cwd, git branch, terminal
 * session ref, agent pid, absolute start/end times, and the tool/turn counters)
 * so the collapsed row can stay terse. Rendered only while the row is expanded;
 * the shell keys its resize round-trip on the expanded state (see
 * `island-shell.tsx` `contentKey`) so growing the row never clips the window.
 */

import { useFormatter, useTranslations } from "next-intl"
import { useReducedMotion } from "motion/react"
import { useCountUp } from "@/hooks/usage/use-count-up"
import { formatCwdMiddle, formatElapsed } from "@/lib/fleet/format"
import type { IslandRowDetail } from "@/lib/island/types"
import { cn } from "@/lib/utils"

const KNOWN_SOURCES = new Set(["startup", "resume", "clear", "compact"])

const TIME_FORMAT = { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" } as const

export function SessionDetail({
  session,
  className,
}: {
  /**
   * The redacted, capped fact block the main window hands over on demand.
   * Structurally a subset of `FleetSession`, so a caller that still holds a
   * whole session can pass it straight through.
   */
  session: IslandRowDetail
  className?: string
}) {
  const t = useTranslations("fleet.row.detail")
  const format = useFormatter()
  // OS-level reduced-motion (no settings-store coupling — the island window may
  // not hydrate it); nullish before hydration → treat as "animate".
  const reduce = useReducedMotion() ?? false
  const tools = useCountUp(session.toolUseCount, { disabled: reduce })
  const turns = useCountUp(session.turnCount, { disabled: reduce })

  const endedAt = session.status === "ended" ? session.endedAt : undefined

  return (
    <div
      data-testid="session-detail"
      className={cn(
        "flex flex-wrap items-center gap-x-2.5 gap-y-0.5 pl-3.5 text-[10px] leading-relaxed text-white/50",
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200",
        className
      )}
    >
      {session.cwd ? (
        <span
          className="inline-flex min-w-0 items-center gap-1"
          data-testid="detail-cwd"
          title={session.cwd}
        >
          <span className="text-white/35">{t("cwd")}</span>
          <span className="truncate text-white/70">{formatCwdMiddle(session.cwd)}</span>
        </span>
      ) : null}

      {session.gitBranch ? (
        <span className="inline-flex items-center gap-1" data-testid="detail-branch">
          <span className="text-white/35">{t("branch")}</span>
          <span className="truncate text-white/70">{session.gitBranch}</span>
        </span>
      ) : null}

      {session.terminal?.sessionRef ? (
        <span className="inline-flex items-center gap-1" data-testid="detail-session-ref">
          <span className="text-white/35">{t("sessionRef")}</span>
          <span className="truncate text-white/70">{session.terminal.sessionRef}</span>
        </span>
      ) : null}

      {session.startSource && KNOWN_SOURCES.has(session.startSource) ? (
        <span className="text-white/60" data-testid="detail-source">
          {t(`source.${session.startSource}`)}
        </span>
      ) : null}

      <span className="tabular-nums text-white/60" data-testid="detail-tools">
        {t("tools", { count: Math.round(tools) })}
      </span>
      <span className="tabular-nums text-white/60" data-testid="detail-turns">
        {t("turns", { count: Math.round(turns) })}
      </span>

      {typeof session.agentPid === "number" ? (
        <span className="tabular-nums text-white/50" data-testid="detail-pid">
          {t("pid", { pid: session.agentPid })}
        </span>
      ) : null}

      <span className="inline-flex items-center gap-1" data-testid="detail-started">
        <span className="text-white/35">{t("started")}</span>
        <span className="text-white/70">
          {format.dateTime(new Date(session.startedAt), TIME_FORMAT)}
        </span>
      </span>

      {endedAt != null ? (
        <>
          <span className="inline-flex items-center gap-1" data-testid="detail-ended">
            <span className="text-white/35">{t("ended")}</span>
            <span className="text-white/70">{format.dateTime(new Date(endedAt), TIME_FORMAT)}</span>
          </span>
          <span className="text-white/60" data-testid="detail-duration">
            {t("duration", { duration: formatElapsed(session.startedAt, endedAt) })}
          </span>
        </>
      ) : null}
    </div>
  )
}

export default SessionDetail
