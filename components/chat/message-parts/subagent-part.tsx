"use client"

/**
 * SubagentPart renderer — assistant-side rendering of a sub-agent
 * invocation. The static identity bits (id, name, status snapshot at part
 * insertion time) come from the part itself; live `progress` + `logs`
 * come from `useSubagentRuntimeStore` via subscription.
 *
 * Mode-aware (mirrors the tool-call flow): every mode renders the shared
 * `ToolRowShell` row (status dot + name + badges + meta + trailing chevron)
 * with the detail body nested under a left rule. `mode` chooses the seed open
 * state and whether narrated stream logs show:
 *  - simplified — collapsed row.
 *  - standard   — collapsed row.
 *  - detailed   — expanded by default (progress + logs + stream text visible).
 *
 * Open state is controllable from the parent tree (expand-all / collapse-all)
 * via `open` + `onToggle`; omit both for self-managed toggling.
 *
 * Phase 8 of the ClaudeCode 完整化 plan.
 */

import { memo, useEffect, useMemo, useState, type MouseEvent } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { toast } from "sonner"
import { AlertTriangleIcon, BotIcon, ExternalLinkIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import { useChatStore } from "@/stores/chat/chat-store"
import type { SubagentPart as SubagentPartType } from "@/lib/claude/parts-extensions"
import { SUB_AGENT_STATUS_CONFIG } from "@/types/agent/sub-agent"
import type { SubAgentToolCall, SubAgentTokenUsage } from "@/types/agent/sub-agent"
import type { AgentFlowMode } from "@/types/appearance"
import { ChainOfThoughtStep } from "@/components/ai-elements/chain-of-thought"
import { ToolRowShell, type ToolDotStatus } from "@/components/chat/message-parts/tool-row"
import { BackgroundedRunControls } from "@/components/chat/message-parts/backgrounded-run-controls"
import {
  ToolActivityGroup,
  type ToolActivityChildOptions,
} from "@/components/chat/message-parts/tool-activity-group"
import { ToolCallRow } from "@/components/chat/message-parts/tool-call-row"
import { toToolActivityEntries } from "@/lib/claude/subagent-tool-parts"
import { jobExecutionRunId } from "@/lib/execution/job-bridge"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { cancelSubagentRun } from "@/lib/claude/agents/cancel-subagent"
import { cn, formatDurationShort } from "@/lib/utils"

/** Sub-agent run status → the shared status-dot colour language. */
const DOT_STATUS: Record<string, ToolDotStatus> = {
  pending: "pending",
  queued: "pending",
  running: "running",
  waiting: "warning",
  completed: "complete",
  failed: "error",
  cancelled: "output-denied",
  timeout: "error",
  rejected: "error",
}

interface Props {
  part: SubagentPartType
  /** Display mode; defaults to `standard` (full card). */
  mode?: AgentFlowMode
  /** Controlled open state; omit for self-managed toggling. */
  open?: boolean
  onToggle?: () => void
}

/** Minimal structural shape of a runtime log entry (level + message + data). */
type SubagentLogEntry = { level: string; message: string; data?: unknown }

/**
 * A coalesced sub-agent stream-text log — the child's narrated reasoning
 * stream (gap8). The runtime store folds consecutive stream text into one
 * trailing entry tagged `data.stream === "text"`. Only surfaced in `detailed`
 * mode so a verbose child doesn't flood simplified/standard transcripts.
 */
function isStreamTextLog(log: { data?: unknown }): boolean {
  const d = log.data
  return typeof d === "object" && d !== null && (d as { stream?: unknown }).stream === "text"
}

/**
 * Open an imported subagent's inner transcript, or explain why it is not there.
 *
 * `kind: "subagent"` sessions are hidden from every listing surface, so a
 * missing one is invisible: `setActiveSession` on an id with no row swaps the
 * pane to an empty conversation that looks like a bug in the transcript rather
 * than an absent record.
 */
async function openNestedTranscript(sessionId: string, missingMessage: string): Promise<void> {
  const { getSession } = await import("@/lib/db/sessions")
  const exists = await getSession(sessionId).catch(() => undefined)
  if (!exists) {
    toast.error(missingMessage)
    return
  }
  useChatStore.getState().setActiveSession(sessionId)
}

/**
 * Shared progress-detail body — summary paragraph, the tail of the log stream,
 * and the "open in workspace" link. Identical between the simplified and the
 * standard/detailed cards (previously duplicated verbatim), and the only place
 * that slices the (potentially long) log array, which it memoizes so the 1s
 * `now` tick on a running subagent doesn't re-slice unchanged logs.
 */
const SubagentLogBody = memo(function SubagentLogBody({
  summary,
  logs,
  lastLog,
  subagentId,
  nestedSessionId,
  mode,
  toolCalls,
  finalResponse,
  tokenUsage,
  cutOff,
}: {
  summary?: string
  logs: SubagentLogEntry[]
  lastLog?: SubagentLogEntry
  subagentId: string
  /** Imported subagents: id of the hidden nested inner-transcript session. */
  nestedSessionId?: string
  mode: AgentFlowMode
  toolCalls: SubAgentToolCall[]
  finalResponse?: string
  tokenUsage?: SubAgentTokenUsage
  /** The run failed mid-stream and `finalResponse` is its salvaged partial. */
  cutOff?: boolean
}) {
  const t = useTranslations("chat.subagentPart")
  const tailLogs = useMemo(() => logs.slice(-50), [logs])
  const entries = useMemo(() => toToolActivityEntries(toolCalls), [toolCalls])
  // Shared group controls each compact row in every mode.
  const renderToolRow = (
    part: (typeof entries)[number]["part"],
    key: string,
    opts: ToolActivityChildOptions
  ) => <ToolCallRow key={key} part={part} expanded={opts.expanded} onToggle={opts.onToggle} />
  return (
    <>
      {summary ? <p className="rounded bg-muted/30 p-2 text-xs">{summary}</p> : null}

      {/* Inline tool list (reuses the main chat's tool flow). */}
      {entries.length >= 2 ? (
        <div data-testid="subagent-tool-activity">
          <ToolActivityGroup entries={entries} mode={mode} renderChild={renderToolRow} />
        </div>
      ) : entries.length === 1 ? (
        <div data-testid="subagent-tool-activity">
          <ToolCallRow
            key={entries[0].key}
            part={entries[0].part}
            defaultOpen={mode === "detailed"}
          />
        </div>
      ) : null}
      {toolCalls.length >= 100 ? (
        <p className="text-[10px] italic text-muted-foreground" data-testid="subagent-tools-tail">
          {t("toolsTailNote", { n: 100 })}
        </p>
      ) : null}

      {/* Final output, once the run produced one. */}
      {finalResponse ? (
        <div className="space-y-1" data-testid="subagent-result">
          <p className="text-[11px] font-medium text-muted-foreground">{t("resultHeading")}</p>
          <div className="rounded bg-muted/30 p-2 text-xs">
            <MarkdownRenderer content={finalResponse} />
          </div>
          {cutOff ? (
            <p className="text-[10px] italic text-amber-600" data-testid="subagent-cutoff-note">
              {t("cutOff")}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Activity log (secondary to the tool list) — the sub-agent's narrated
          chain of thought, rendered as a connected step timeline. */}
      {logs.length > 0 ? (
        <div className="space-y-2" data-testid="subagent-logs">
          {tailLogs.map((log, i) => (
            <ChainOfThoughtStep
              key={i}
              icon={log.level === "error" || log.level === "warn" ? AlertTriangleIcon : undefined}
              status={i === tailLogs.length - 1 ? "active" : "complete"}
              label={<span className="break-words font-mono text-[11px]">{log.message}</span>}
            />
          ))}
          {logs.length >= 50 ? (
            <p
              className="text-[10px] italic text-muted-foreground"
              data-testid="subagent-logs-tail"
            >
              {t("logsTailNote", { n: 50 })}
            </p>
          ) : null}
        </div>
      ) : lastLog ? (
        <p className="font-mono text-[11px] text-muted-foreground">{lastLog.message}</p>
      ) : entries.length === 0 ? (
        <p className="text-[11px] italic text-muted-foreground">{t("noLogsYet")}</p>
      ) : null}

      {tokenUsage ? (
        <p className="text-[10px] text-muted-foreground" data-testid="subagent-tokens-breakdown">
          {t("tokensBreakdown", {
            prompt: tokenUsage.promptTokens,
            completion: tokenUsage.completionTokens,
            total: tokenUsage.totalTokens,
          })}
        </p>
      ) : null}

      {nestedSessionId ? (
        // Imported subagent (ADR-0062): drill into the hidden nested session
        // holding this run's full inner transcript. In-app store navigation,
        // not a route link.
        //
        // The target is checked on click rather than on render: a long
        // transcript can carry dozens of these cards, and a Dexie live query per
        // card to grey out a button is far more expensive than the miss it
        // guards. Navigating to a missing session used to swap the pane to a
        // blank conversation with no explanation — reachable whenever the inner
        // transcript did not survive a round trip.
        <button
          type="button"
          onClick={() => void openNestedTranscript(nestedSessionId, t("transcriptMissing"))}
          className="inline-flex items-center gap-1 text-xs underline"
          data-testid="subagent-open-transcript"
        >
          {t("openTranscript")}
          <ExternalLinkIcon className="size-3" />
        </button>
      ) : (
        // Into the run cockpit, on the EXECUTION run id. This used to point at
        // `/agent-teams?focus=subagent:<id>`, a param that page never read — so
        // the link on every sub-agent card in every transcript just dropped the
        // operator on the team list. `job-bridge` projects the run's journal row
        // (written for foreground and background dispatches alike) onto
        // `execution:job:<runId>`, and `part.subagentId` is that same runId, so
        // the target survives a reload — unlike the ephemeral runtime store.
        <Link
          href={`/agent-runs?run=${encodeURIComponent(jobExecutionRunId(subagentId))}`}
          className="inline-flex items-center gap-1 text-xs underline"
          data-testid="subagent-open"
        >
          {t("openInRuns")}
          <ExternalLinkIcon className="size-3" />
        </Link>
      )}
    </>
  )
})

export const SubagentPart = memo(function SubagentPart({
  part,
  mode = "standard",
  open,
  onToggle,
}: Props) {
  const t = useTranslations("chat.subagentPart")
  const tStatus = useTranslations("agentStatus")
  // Live read for progress + logs; falls back to the static part snapshot.
  const live = useSubagentRuntimeStore((s) => s.subAgents[part.subagentId])

  const status = live?.status ?? part.status
  // Honest live tool-call count (Claude Code / Codex style) — replaces the old
  // pseudo-percentage progress bar, which implied a completion ratio a subagent
  // run doesn't actually have. gap7: falls back to the persisted snapshot when
  // the ephemeral runtime store no longer has the run (post-reload).
  const toolUses = live?.toolUses ?? part.toolUses ?? 0
  const cfg = SUB_AGENT_STATUS_CONFIG[status]
  // gap8: the narrated reasoning stream (coalesced stream-text logs) is only
  // surfaced in `detailed`; simplified/standard show tools + final response.
  const allLogs: SubagentLogEntry[] = live?.logs ?? part.logs ?? []
  const logs = mode === "detailed" ? allLogs : allLogs.filter((l) => !isStreamTextLog(l))
  const lastLog = logs[logs.length - 1]
  const rejection = live?.rejection ?? part.rejection
  const backgrounded = (live?.backgrounded ?? part.backgrounded) === true && status === "running"
  const depth = live?.depth ?? part.depth
  // Prefer the LIVE cumulative usage while running (fed by the dispatch run
  // tracker), then the authoritative result usage, then the persisted part.
  const tokenUsage = live?.tokenUsage ?? live?.result?.tokenUsage ?? part.tokenUsage
  const tokenTotal = tokenUsage?.totalTokens
  const retryCount = live?.retryCount ?? 0
  const cutOff = (live?.errorEnvelope?.partialText ?? "").length > 0
  const toolCalls = live?.toolCalls ?? part.toolCalls ?? []
  const finalResponse = live?.result?.finalResponse ?? part.finalResponse
  const isRunning = part.completedAt == null && status === "running"
  const canAbort = status === "running"
  const handleAbort = (e: MouseEvent) => {
    e.stopPropagation()
    cancelSubagentRun(part.subagentId, { backgrounded })
  }
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    if (!isRunning) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [isRunning])
  // Rendered through `formatDurationShort` ("2.4s", "1m 12s"), not raw
  // milliseconds. A five-minute run used to print "301274ms": unreadable, and
  // an unbounded-width cell in a row that already competes for space.
  const durationMs =
    part.completedAt != null ? part.completedAt - part.startedAt : now - part.startedAt

  const controlled = open !== undefined
  const [internalOpen, setInternalOpen] = useState<boolean | null>(null)
  const isOpen = controlled ? (open as boolean) : (internalOpen ?? mode === "detailed")
  const toggle = () => {
    if (controlled) onToggle?.()
    else setInternalOpen(!isOpen)
  }

  const statusLabel = tStatus(cfg.labelKey)

  const rejectionBanner = rejection ? (
    <p
      className="mt-1 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
      data-testid="subagent-rejection"
    >
      {rejection.reason === "cycle" ? t("rejected.cycle") : t("rejected.maxDepth")}
    </p>
  ) : null
  // One row grammar in every mode: the simplified row and the old standard
  // card collapse into the shared `ToolRowShell` chrome — the status dot
  // carries the run state, badges + meta sit right-aligned, the abort button
  // is a hover action, and the body nests under the row's left rule. `mode`
  // now only chooses the seed open state + whether narrated stream logs show.
  return (
    <div
      // `@container/subagent` measures THIS row, not the viewport: the same
      // row renders full width in a desktop transcript and three levels deep
      // inside a subagent tree on a phone. Every piece of chrome below drops
      // in priority order rather than pushing the name out of the box.
      className="@container/subagent not-prose my-0.5"
      data-testid={`subagent-part-${part.subagentId}`}
      data-status={status}
      data-open={isOpen}
    >
      <ToolRowShell
        status={DOT_STATUS[status] ?? "pending"}
        open={isOpen}
        onToggle={toggle}
        ariaLabel={t("rowAria", { name: part.name, status: statusLabel })}
        testId={`subagent-row-${part.subagentId}`}
        toggleTestId={`subagent-toggle-${part.subagentId}`}
        lead={
          <span className="min-w-0 max-w-[40%] truncate text-xs font-medium text-foreground/80">
            {part.name}
          </span>
        }
        icon={<BotIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
        target={
          // Lowest-priority cell: the log preview is simply dropped below
          // ~384px, and the name above claims the width it was using.
          <span className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground @sm/subagent:block">
            {lastLog?.message ?? ""}
          </span>
        }
        badges={
          <>
            {/* The dot alone can't distinguish failed/cancelled/timeout — the
                text badge keeps the named status legible. */}
            <Badge
              variant="outline"
              className={cn("text-[10px]", cfg.color)}
              data-testid="subagent-status-badge"
            >
              {statusLabel}
            </Badge>
            {typeof depth === "number" ? (
              <Badge variant="secondary" className="text-[10px]" data-testid="subagent-depth-badge">
                {t("depthBadge", { n: depth })}
              </Badge>
            ) : null}
            {backgrounded ? (
              <Badge
                variant="outline"
                className="text-[10px] text-muted-foreground"
                data-testid="subagent-background-badge"
              >
                {t("backgroundRunning")}
              </Badge>
            ) : null}
            {isRunning && retryCount > 0 ? (
              <Badge
                variant="outline"
                className="text-[10px] text-amber-600"
                data-testid="subagent-retry-badge"
              >
                {t("retrying", { n: retryCount })}
              </Badge>
            ) : null}
            {typeof tokenTotal === "number" && tokenTotal > 0 ? (
              <Badge
                variant="outline"
                className="hidden text-[10px] text-muted-foreground @md/subagent:inline-flex"
                data-testid="subagent-tokens-badge"
              >
                {t("tokens", { n: tokenTotal })}
              </Badge>
            ) : null}
          </>
        }
        meta={
          <>
            {isRunning && toolUses > 0 ? (
              <span
                className="hidden shrink-0 text-[11px] text-muted-foreground tabular-nums @md/subagent:inline"
                data-testid="subagent-tools-count"
              >
                {t("toolsRunCount", { n: toolUses })}
              </span>
            ) : null}
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {formatDurationShort(durationMs)}
            </span>
            <span className="sr-only">{statusLabel}</span>
          </>
        }
        actions={
          <BackgroundedRunControls
            variant="icon"
            isRunning={canAbort}
            onAbort={handleAbort}
            abortAria={t("abort")}
            abortTestId={`subagent-abort-${part.subagentId}`}
          />
        }
      >
        <div className="mb-1 space-y-2 border-l pl-3 pt-1">
          <SubagentLogBody
            summary={part.summary}
            logs={logs}
            lastLog={lastLog}
            subagentId={part.subagentId}
            nestedSessionId={part.nestedSessionId}
            mode={mode}
            toolCalls={toolCalls}
            finalResponse={finalResponse}
            tokenUsage={tokenUsage}
            cutOff={cutOff}
          />
        </div>
      </ToolRowShell>
      {/* A rejection is the reason the run never started — it must stay
          visible even when the row is collapsed. */}
      {rejectionBanner}
    </div>
  )
})
