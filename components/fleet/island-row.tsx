"use client"

/**
 * IslandRow — one monitored session in the expanded island, mirroring the
 * reference layout: agent badge + project name on the lead line with the
 * terminal source and elapsed time on the right; the last user prompt and the
 * current activity (or waiting state) underneath. A pending permission swaps
 * the activity line for Approve/Deny controls.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, ChevronDownIcon, FileTextIcon } from "lucide-react"
import { AgentBadge } from "./agent-badge"
import { TerminalBadge } from "./terminal-badge"
import { IslandPermissionActions } from "./island-permission-actions"
import { IslandReply } from "./island-reply"
import { SessionMetaChips } from "./session-meta-chips"
import { SessionDetail } from "./session-detail"
import { activityLine, formatElapsed, truncateLine } from "@/lib/fleet/format"
import { useNowTicker } from "@/hooks/fleet/use-now-ticker"
import { fleetFocusTerminal, fleetRevealTranscript } from "@/lib/tauri/fleet"
import type { FleetSession, FleetStatus } from "@/lib/fleet/types"
import { cn } from "@/lib/utils"

const STATUS_DOT: Record<FleetStatus, string> = {
  working: "bg-emerald-400 animate-pulse",
  "waiting-permission": "bg-red-400 animate-pulse",
  "plan-pending": "bg-sky-400 animate-pulse",
  "waiting-input": "bg-amber-400",
  idle: "bg-white/30",
  ended: "bg-white/15",
}

/** Statuses that pull the user in — the flash fires on a fresh entry into one. */
const ATTENTION_STATUSES = new Set<FleetStatus>([
  "waiting-permission",
  "plan-pending",
  "waiting-input",
])

export function IslandRow({
  session,
  enterDelayMs = 0,
  detailExpanded = false,
  onToggleDetail,
}: {
  session: FleetSession
  /** Stagger offset for the entrance animation (list index × step). */
  enterDelayMs?: number
  /** Whether this row's detail panel is expanded (state owned by the shell so
   * the resize round-trip can key on it). */
  detailExpanded?: boolean
  /** Toggle the detail panel; when omitted the chevron affordance is hidden. */
  onToggleDetail?: () => void
}) {
  const t = useTranslations("fleet.row")
  // Live elapsed labels tick off the single shared fleet ticker (one interval
  // for every row + permission card) rather than a per-row `setInterval`.
  const nowMs = useNowTicker()

  // One-shot highlight when the row NEWLY needs the user (a status transition
  // into an attention state). Uses the repo's "adjust state during render when
  // a tracked value changed" pattern (see island-shell tuck reset) — tracked in
  // state (not a ref, which the react-hooks lint forbids reading during render);
  // `prevStatus` is set in the same render, so the branch can't loop.
  const [flashing, setFlashing] = useState(false)
  const [prevStatus, setPrevStatus] = useState(session.status)
  if (prevStatus !== session.status) {
    const enteringAttention =
      ATTENTION_STATUSES.has(session.status) && !ATTENTION_STATUSES.has(prevStatus)
    setPrevStatus(session.status)
    if (enteringAttention) setFlashing(true)
  }

  const activity = activityLine(session)

  const canFocus = session.capabilities.focusTerminal
  const focusTerminal = () => {
    if (canFocus) void fleetFocusTerminal(session.agent, session.sessionId)
  }

  // The transcript file can be revealed in the OS file manager once the agent
  // has reported its path (a `SessionStart` carries it) — surfaces the row's
  // otherwise-unused `openTranscript` capability.
  const canRevealTranscript = session.capabilities.openTranscript && Boolean(session.transcriptPath)
  const revealTranscript = () => {
    if (session.transcriptPath) void fleetRevealTranscript(session.transcriptPath)
  }

  // OpenCode sessions can receive an injected prompt (see fleet/opencode.rs).
  const canReply = session.capabilities.sendMessage && session.status !== "ended"

  // How long a blocked session has been waiting (its last event is the moment
  // it entered the waiting state). Permission rows carry their own countdown.
  const waitedFor =
    session.status === "plan-pending" || session.status === "waiting-input"
      ? formatElapsed(session.lastEventAt, nowMs)
      : null

  // A parked AskUserQuestion replaces the generic waiting-input status line
  // with the actual question + option chips (display-only — it is answered in
  // the agent's own terminal).
  const questions = session.status === "waiting-input" ? (session.pendingQuestions ?? []) : []
  const firstQuestion = questions.length > 0 ? questions[0] : null
  const moreQuestions = Math.max(0, questions.length - 1)
  const subagents = session.subagents ?? []
  const lastError = session.lastError ?? null
  // Ended rows freeze their runtime at the end time; live rows keep ticking.
  const elapsedReference = session.status === "ended" ? (session.endedAt ?? nowMs) : nowMs

  const statusLine = (() => {
    switch (session.status) {
      case "waiting-permission":
        // Rendered by IslandPermissionActions below (or a plain hint when the
        // request isn't approvable from here).
        return session.pendingPermission ? null : t("status.waitingPermission")
      case "plan-pending":
        return t("status.planPending")
      case "waiting-input":
        return t("status.waitingInput")
      case "ended":
        return t("status.ended")
      case "idle":
        return activity ?? t("status.idle")
      case "working":
        return activity ?? t("status.working")
    }
  })()

  return (
    <div
      data-testid={`island-row-${session.agent}-${session.sessionId}`}
      data-status={session.status}
      className={cn(
        "relative flex flex-col gap-0.5 rounded-xl px-3 py-2 transition-colors duration-200 hover:bg-white/5",
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-200",
        canFocus && "cursor-pointer"
      )}
      // Backwards fill keeps a delayed row invisible until its stagger slot;
      // inline (not a utility) so the entrance never flashes if the fill-mode
      // utility is unavailable.
      style={
        enterDelayMs > 0
          ? { animationDelay: `${enterDelayMs}ms`, animationFillMode: "backwards" }
          : undefined
      }
      onClick={canFocus ? focusTerminal : undefined}
      role={canFocus ? "button" : undefined}
      tabIndex={canFocus ? 0 : undefined}
      aria-label={canFocus ? t("focusTerminal") : undefined}
      onKeyDown={
        canFocus
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                focusTerminal()
              }
            }
          : undefined
      }
    >
      {flashing ? (
        <span
          aria-hidden
          data-testid="row-flash"
          className="island-attention-flash pointer-events-none absolute inset-0 rounded-xl"
          onAnimationEnd={() => setFlashing(false)}
        />
      ) : null}
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          data-testid="status-dot"
          className={cn(
            "size-1.5 shrink-0 rounded-full transition-colors duration-300",
            STATUS_DOT[session.status],
            // Orthogonal error accent — a ring, so the status colour is kept.
            lastError && "ring-1 ring-red-400/70"
          )}
        />
        <AgentBadge agent={session.agent} />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-white/90">
          {session.projectName ?? session.sessionId}
        </span>
        {session.terminal ? <TerminalBadge terminal={session.terminal} /> : null}
        <span className="shrink-0 text-[10px] tabular-nums text-white/50" data-testid="elapsed">
          {formatElapsed(session.startedAt, elapsedReference)}
        </span>
        {onToggleDetail ? (
          <button
            type="button"
            data-testid="session-detail-toggle"
            aria-label={detailExpanded ? t("detail.toggleHide") : t("detail.toggleShow")}
            aria-expanded={detailExpanded}
            onClick={(e) => {
              e.stopPropagation()
              onToggleDetail()
            }}
            onKeyDown={(e) => e.stopPropagation()}
            className="shrink-0 rounded-md p-0.5 text-white/50 transition-colors hover:bg-white/10 hover:text-white/80"
          >
            <ChevronDownIcon
              className={cn(
                "size-3 transition-transform duration-200",
                detailExpanded && "rotate-180"
              )}
              aria-hidden
            />
          </button>
        ) : null}
        {canRevealTranscript ? (
          <button
            type="button"
            data-testid="island-reveal-transcript"
            aria-label={t("openTranscript")}
            onClick={(e) => {
              e.stopPropagation()
              revealTranscript()
            }}
            onKeyDown={(e) => e.stopPropagation()}
            className="shrink-0 rounded-md p-0.5 text-white/50 transition-colors hover:bg-white/10 hover:text-white/80"
          >
            <FileTextIcon className="size-3" aria-hidden />
          </button>
        ) : null}
        {canReply ? <IslandReply sessionId={session.sessionId} /> : null}
      </div>

      <SessionMetaChips session={session} className="pl-3.5" />

      {detailExpanded ? <SessionDetail session={session} /> : null}

      {session.lastPrompt ? (
        <p className="truncate pl-3.5 text-[11px] text-white/60" data-testid="last-prompt">
          {t("you")} {truncateLine(session.lastPrompt, 140)}
        </p>
      ) : null}

      {lastError ? (
        <div
          data-testid="row-error"
          className="ml-3.5 flex items-start gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] leading-snug text-red-200/90 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200"
        >
          <AlertTriangleIcon className="mt-px size-3 shrink-0 text-red-400" aria-hidden />
          <span className="min-w-0">
            <span className="font-semibold" data-testid="row-error-kind">
              {t(`error.${lastError.kind}`)}
            </span>
            {lastError.detail ? (
              <span className="text-red-200/70"> · {truncateLine(lastError.detail, 120)}</span>
            ) : null}
          </span>
        </div>
      ) : null}

      {session.pendingPermission ? (
        // Stop clicks on the Approve/Deny controls from also focusing the
        // terminal (the row is a focus-terminal button when capable).
        <div
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          role="presentation"
        >
          <IslandPermissionActions pending={session.pendingPermission} className="pl-3.5" />
        </div>
      ) : statusLine && !firstQuestion ? (
        <p className="truncate pl-3.5 text-[11px] text-white/45" data-testid="status-line">
          {statusLine}
          {waitedFor ? (
            <span className="text-white/35" data-testid="status-waited">
              {" · "}
              {t("waitingFor", { duration: waitedFor })}
            </span>
          ) : null}
        </p>
      ) : null}

      {firstQuestion ? (
        <div
          data-testid="pending-question"
          className="ml-3.5 space-y-1 rounded-lg border border-amber-400/20 bg-amber-500/10 px-2 py-1.5 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200"
        >
          <p className="text-[11px] leading-snug text-amber-100/90">
            {firstQuestion.header ? (
              <span className="mr-1.5 rounded bg-amber-400/20 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-200">
                {firstQuestion.header}
              </span>
            ) : null}
            {firstQuestion.multiSelect ? (
              <span
                data-testid="question-multiselect"
                className="mr-1.5 rounded bg-amber-400/15 px-1 py-px text-[9px] font-medium text-amber-200/80"
              >
                {t("multiSelect")}
              </span>
            ) : null}
            {truncateLine(firstQuestion.question, 200)}
          </p>
          {firstQuestion.options.length > 0 ? (
            <div className="flex flex-wrap gap-1" data-testid="question-options">
              {firstQuestion.options.map((option) => (
                <span
                  key={option}
                  className="rounded-md bg-white/10 px-1.5 py-0.5 text-[10px] text-white/70"
                >
                  {truncateLine(option, 40)}
                </span>
              ))}
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            {moreQuestions > 0 ? (
              <p className="text-[10px] text-amber-200/60" data-testid="question-more">
                {t("questionMore", { count: moreQuestions })}
              </p>
            ) : (
              <span />
            )}
            {waitedFor ? (
              <p
                className="text-[10px] tabular-nums text-amber-200/50"
                data-testid="question-waited"
              >
                {t("waitingFor", { duration: waitedFor })}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {session.status === "plan-pending" && session.pendingPlan ? (
        <div
          data-testid="pending-plan"
          className="ml-3.5 line-clamp-3 whitespace-pre-wrap rounded-lg border border-sky-400/20 bg-sky-500/10 px-2 py-1.5 text-[10px] leading-snug text-sky-100/85 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200"
        >
          {session.pendingPlan}
        </div>
      ) : null}

      {subagents.length > 0 ? (
        <div
          data-testid="subagents"
          className="ml-3.5 flex flex-wrap items-center gap-1 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200"
        >
          <span className="text-[10px] text-white/45">
            {t("subagents", { count: subagents.length })}
          </span>
          {subagents.slice(0, 3).map((subagent, i) => (
            <span
              key={`${subagent.startedAt}-${i}`}
              data-testid={`subagent-chip-${i}`}
              data-background={subagent.background ? "true" : "false"}
              className="inline-flex max-w-56 items-center gap-1 rounded-md bg-white/10 px-1.5 py-0.5 text-[10px] text-white/70"
            >
              {subagent.background ? (
                <span
                  aria-hidden
                  className="size-1 shrink-0 animate-pulse rounded-full bg-violet-400"
                />
              ) : null}
              <span className="truncate">
                {subagent.agentType ? `${subagent.agentType} · ` : ""}
                {truncateLine(subagent.description, 48)}
              </span>
              {subagent.background ? (
                <span className="shrink-0 text-[9px] uppercase tracking-wide text-violet-300/80">
                  {t("subagentBackground")}
                </span>
              ) : null}
              <span
                className="shrink-0 tabular-nums text-white/40"
                data-testid={`subagent-elapsed-${i}`}
              >
                {formatElapsed(subagent.startedAt, nowMs)}
              </span>
            </span>
          ))}
          {subagents.length > 3 ? (
            <span className="text-[10px] text-white/40" data-testid="subagent-overflow">
              +{subagents.length - 3}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export default IslandRow
