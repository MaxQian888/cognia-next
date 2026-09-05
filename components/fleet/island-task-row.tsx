"use client"

/**
 * One task or pending item in the expanded island.
 *
 * Renders an `IslandRowProjection` and nothing else. It holds no store, issues
 * no Tauri business command, and reads no raw session: every control emits a
 * typed intent that the main window re-validates and executes. A control is
 * rendered only when the projection proved its capability, so a button that is
 * on screen is a button whose intent will be accepted.
 *
 * Privacy: the row shows the safe summary at all times. The detail block below
 * it appears only once the row is pinned (or on hover under the `hover`
 * policy), and the detail itself is fetched on demand and dropped when the pin
 * moves. Nothing sensitive is held in the projection this row receives.
 */

import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  FileTextIcon,
  SquareIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react"

import { useNowTicker } from "@/hooks/fleet/use-now-ticker"
import type { IslandActionRequest, IslandActionStatus } from "@/hooks/island/use-island-actions"
import { formatElapsed } from "@/lib/fleet/format"
import type { DistributiveOmit, IslandRowDetail, IslandRowProjection } from "@/lib/island/types"
import { cn } from "@/lib/utils"
import { AgentBadge } from "./agent-badge"
import { IslandPermissionActions } from "./island-permission-actions"
import { IslandQuestionActions } from "./island-question-actions"
import { IslandReply } from "./island-reply"
import { SessionDetail } from "./session-detail"
import { SessionMetaChips } from "./session-meta-chips"
import { TerminalBadge } from "./terminal-badge"

const STATUS_DOT: Record<IslandRowProjection["status"], string> = {
  blocked: "bg-amber-400 animate-pulse",
  failed: "bg-red-400",
  working: "bg-emerald-400 animate-pulse",
  done: "bg-white/25",
  idle: "bg-white/30",
  stale: "bg-slate-400/40",
}

export interface IslandTaskRowProps {
  row: IslandRowProjection
  revision: number
  /** Whether this row's detail panel is open (pin state owned by the shell). */
  pinned: boolean
  onTogglePin(): void
  /** Fetched detail for this row, or null while it is unpinned or refused. */
  detail: IslandRowDetail | null
  /** `fleet.island.detailError.*` key when the request was refused. */
  detailError: string | null
  dispatch(intent: IslandActionRequest): Promise<boolean>
  statusOf(kind: IslandActionRequest["kind"]): IslandActionStatus
  /** Trim ambient context when the list is long. Blocking blocks always stay. */
  compact?: boolean
  enterDelayMs?: number
}

export function IslandTaskRow({
  row,
  revision,
  pinned,
  onTogglePin,
  detail,
  detailError,
  dispatch,
  statusOf,
  compact = false,
  enterDelayMs = 0,
}: IslandTaskRowProps) {
  const t = useTranslations("fleet.island")
  const nowMs = useNowTicker()

  // The row supplies the payload, the row's identity and revision are filled in
  // here so no control can address a different row than the one it sits on.
  const send = (intent: DistributiveOmit<IslandActionRequest, "rowId" | "revision">) =>
    dispatch({ ...intent, rowId: row.id, revision } as IslandActionRequest)

  const openOwner = statusOf("open-owner")
  const interrupt = statusOf("interrupt")
  const focus = statusOf("focus-terminal")
  const transcript = statusOf("open-transcript")
  const dismiss = statusOf("dismiss-stale")
  const actionError =
    openOwner.error ?? interrupt.error ?? focus.error ?? transcript.error ?? dismiss.error

  const waitedFor = row.waitingSince ? formatElapsed(row.waitingSince, nowMs) : null
  const showSecondary = !compact || pinned

  return (
    <div
      data-testid={`island-task-row-${row.id}`}
      data-status={row.status}
      data-source={row.source}
      data-compact={compact ? "true" : "false"}
      className={cn(
        "relative flex flex-col gap-0.5 rounded-xl px-3 py-2 transition-colors duration-200 hover:bg-white/5",
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-200",
        row.stale && "opacity-60"
      )}
      style={
        enterDelayMs > 0
          ? { animationDelay: `${enterDelayMs}ms`, animationFillMode: "backwards" }
          : undefined
      }
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          data-testid="status-dot"
          className={cn(
            "size-1.5 shrink-0 rounded-full transition-colors duration-300",
            STATUS_DOT[row.status]
          )}
        />
        {row.agent ? (
          <AgentBadge agent={row.agent} />
        ) : (
          <span
            data-testid="island-source-badge"
            className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-white/60"
          >
            {t(`source.${row.source}`)}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-white/90">
          {row.title}
        </span>
        {row.hostRef ? (
          <span
            data-testid="island-host-badge"
            className="max-w-28 shrink-0 truncate rounded bg-white/10 px-1.5 py-0.5 text-[9px] text-white/60"
          >
            {row.hostRef}
          </span>
        ) : null}
        {row.terminal ? <TerminalBadge terminal={row.terminal} /> : null}
        <span className="shrink-0 text-[10px] tabular-nums text-white/50" data-testid="elapsed">
          {formatElapsed(row.startedAt, row.status === "done" ? row.updatedAt : nowMs)}
        </span>

        {row.capabilities.detail ? (
          <button
            type="button"
            data-testid="island-detail-toggle"
            aria-label={pinned ? t("detail.hide") : t("detail.show")}
            aria-expanded={pinned}
            onClick={onTogglePin}
            className="shrink-0 rounded-md p-0.5 text-white/50 transition-colors hover:bg-white/10 hover:text-white/80"
          >
            <ChevronDownIcon
              className={cn("size-3 transition-transform duration-200", pinned && "rotate-180")}
              aria-hidden
            />
          </button>
        ) : null}

        {row.capabilities.openOwner ? (
          <button
            type="button"
            data-testid="island-open-owner"
            aria-label={t(`openOwner.${row.source}`)}
            disabled={openOwner.pending}
            onClick={() => void send({ kind: "open-owner" })}
            className="shrink-0 rounded-md p-0.5 text-white/50 transition-colors hover:bg-white/10 hover:text-white/80 disabled:opacity-40"
          >
            <ExternalLinkIcon className="size-3" aria-hidden />
          </button>
        ) : null}

        {row.capabilities.focusTerminal ? (
          <button
            type="button"
            data-testid="island-focus-terminal"
            aria-label={t("focusTerminal")}
            disabled={focus.pending}
            onClick={() => void send({ kind: "focus-terminal" })}
            className="shrink-0 rounded-md p-0.5 text-white/50 transition-colors hover:bg-white/10 hover:text-white/80 disabled:opacity-40"
          >
            <TerminalIcon className="size-3" aria-hidden />
          </button>
        ) : null}

        {row.capabilities.openTranscript ? (
          <button
            type="button"
            data-testid="island-reveal-transcript"
            aria-label={t("openTranscript")}
            disabled={transcript.pending}
            onClick={() => void send({ kind: "open-transcript" })}
            className="shrink-0 rounded-md p-0.5 text-white/50 transition-colors hover:bg-white/10 hover:text-white/80 disabled:opacity-40"
          >
            <FileTextIcon className="size-3" aria-hidden />
          </button>
        ) : null}

        {row.capabilities.interrupt ? (
          <button
            type="button"
            data-testid="island-interrupt"
            aria-label={t("interrupt")}
            disabled={interrupt.pending}
            onClick={() => void send({ kind: "interrupt" })}
            className="shrink-0 rounded-md p-0.5 text-white/50 transition-colors hover:bg-red-500/20 hover:text-red-300 disabled:opacity-40"
          >
            <SquareIcon className="size-3 fill-current" aria-hidden />
          </button>
        ) : null}

        {row.capabilities.dismissStale ? (
          <button
            type="button"
            data-testid="island-dismiss"
            aria-label={t("dismiss")}
            disabled={dismiss.pending}
            onClick={() => void send({ kind: "dismiss-stale" })}
            className="shrink-0 rounded-md p-0.5 text-white/50 transition-colors hover:bg-white/10 hover:text-white/80 disabled:opacity-40"
          >
            <XIcon className="size-3" aria-hidden />
          </button>
        ) : null}

        {row.capabilities.reply && row.owner.kind === "external" ? (
          <IslandReply
            sessionId={row.owner.sessionId}
            send={async (_sessionId, text) =>
              (await send({ kind: "reply", text })) ? "sent" : null
            }
          />
        ) : null}
      </div>

      {row.permission && row.capabilities.permissionDecision ? (
        <IslandPermissionActions
          pending={{ ...row.permission, detail: null }}
          className="pl-3.5"
          respond={(requestId, behavior) =>
            send({ kind: "permission-decision", permissionRequestId: requestId, behavior })
          }
        />
      ) : row.question && row.capabilities.questionResponse ? (
        <IslandQuestionActions
          key={row.question.requestId}
          className="ml-3.5"
          request={{ requestId: row.question.requestId, requestedAt: row.question.requestedAt }}
          questions={row.question.questions.map((question) => ({
            question: question.question,
            header: question.header ?? null,
            options: question.options,
            multiSelect: question.multiSelect,
          }))}
          respond={(requestId, selections) =>
            send({ kind: "question-response", questionRequestId: requestId, selections })
          }
          reject={(requestId) => send({ kind: "question-reject", questionRequestId: requestId })}
        />
      ) : (
        <p className="truncate pl-3.5 text-[11px] text-white/45" data-testid="island-status-line">
          {row.summary || t(`state.${row.statusKey ?? row.status}`)}
          {waitedFor ? (
            <span className="text-white/35" data-testid="island-waited">
              {" · "}
              {t("waitingFor", { duration: waitedFor })}
            </span>
          ) : null}
          {/*
           * A blocked Cognia row (chat approval, team gate, run interrupt) has
           * no decision controls here yet — see IslandRowCapabilities. Say so,
           * rather than leaving a wait with no visible way out.
           */}
          {row.status === "blocked" && row.owner.kind !== "external" ? (
            <span className="text-white/35" data-testid="island-decide-in-main">
              {" · "}
              {t("decideInMain")}
            </span>
          ) : null}
        </p>
      )}

      {actionError ? (
        <p
          role="status"
          data-testid="island-action-error"
          className="flex items-center gap-1 pl-3.5 text-[10px] leading-snug text-red-200/80"
        >
          <AlertTriangleIcon className="size-3 shrink-0 text-red-400" aria-hidden />
          {t(`actionError.${actionError}`)}
        </p>
      ) : null}

      {pinned && showSecondary ? (
        detail ? (
          <>
            <SessionMetaChips session={detail} className="pl-3.5" />
            <SessionDetail session={detail} />
            {detail.prompt ? (
              <p className="truncate pl-3.5 text-[11px] text-white/60" data-testid="island-prompt">
                {detail.prompt}
              </p>
            ) : null}
            {detail.plan ? (
              <div
                data-testid="island-plan"
                className="ml-3.5 line-clamp-3 whitespace-pre-wrap rounded-lg border border-sky-400/20 bg-sky-500/10 px-2 py-1.5 text-[10px] leading-snug text-sky-100/85"
              >
                {detail.plan}
              </div>
            ) : null}
            {detail.errorDetail ? (
              <p
                data-testid="island-error-detail"
                className="ml-3.5 rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] leading-snug text-red-200/90"
              >
                {detail.errorDetail}
              </p>
            ) : null}
          </>
        ) : (
          <p
            role="status"
            data-testid="island-detail-status"
            className="pl-3.5 text-[10px] text-white/40"
          >
            {detailError ? t(`detailError.${detailError}`) : t("detail.loading")}
          </p>
        )
      ) : null}
    </div>
  )
}

export default IslandTaskRow
