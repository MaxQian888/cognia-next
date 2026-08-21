"use client"

/**
 * SubagentPart renderer — assistant-side rendering of a sub-agent
 * invocation. The static identity bits (id, name, status snapshot at part
 * insertion time) come from the part itself; live `progress` + `logs`
 * come from `useSubagentRuntimeStore` via subscription.
 *
 * Mode-aware (mirrors the tool-call flow):
 *  - simplified — compact single row (icon + name + status glyph + duration);
 *                 clicking expands progress/logs inline. Matches `ToolCallRow`.
 *  - standard   — full card, collapsed by default.
 *  - detailed   — full card, expanded by default (progress + logs visible).
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
import {
  AlertTriangleIcon,
  BanIcon,
  BotIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  CircleIcon,
  ClockIcon,
  ExternalLinkIcon,
  Loader2Icon,
  PauseIcon,
  ShieldAlertIcon,
  XCircleIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import { useChatStore } from "@/stores/chat/chat-store"
import type { SubagentPart as SubagentPartType } from "@/lib/claude/parts-extensions"
import { SUB_AGENT_STATUS_CONFIG } from "@/types/agent/sub-agent"
import type { SubAgentToolCall, SubAgentTokenUsage } from "@/types/agent/sub-agent"
import type { AgentFlowMode } from "@/types/appearance"
import { ChainOfThoughtStep } from "@/components/ai-elements/chain-of-thought"
import { MotionStatusSwap, ReadingCollapse } from "@/components/chat/motion/motion-reveal"
import { BackgroundedRunControls } from "@/components/chat/message-parts/backgrounded-run-controls"
import {
  ToolActivityGroup,
  type ToolActivityChildOptions,
} from "@/components/chat/message-parts/tool-activity-group"
import { ToolCallRow } from "@/components/chat/message-parts/tool-call-row"
import { toToolActivityEntries } from "@/lib/claude/subagent-tool-parts"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { cancelSubagentRun } from "@/lib/claude/agents/cancel-subagent"
import { cn } from "@/lib/utils"

/** Status → concrete glyph for the simplified row + card header. */
const STATUS_GLYPH: Record<string, { Icon: LucideIcon; className: string }> = {
  pending: { Icon: CircleIcon, className: "text-muted-foreground" },
  queued: { Icon: ClockIcon, className: "text-blue-500" },
  running: { Icon: Loader2Icon, className: "animate-spin text-primary" },
  waiting: { Icon: PauseIcon, className: "text-yellow-500" },
  completed: { Icon: CheckCircleIcon, className: "text-green-600 dark:text-green-500" },
  failed: { Icon: XCircleIcon, className: "text-destructive" },
  cancelled: { Icon: BanIcon, className: "text-orange-500" },
  timeout: { Icon: AlertTriangleIcon, className: "text-red-500" },
  rejected: { Icon: ShieldAlertIcon, className: "text-destructive" },
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
  // A sub-agent's tool list is compact in every display mode, so the child is
  // always a row. Honour whichever open-state channel the group is using —
  // controlled (`expanded`/`onToggle`, simplified) or seeded-at-mount
  // (`forceOpen` + the group's generation-stamped key, standard/detailed) —
  // otherwise the group's expand-all button is inert here.
  const renderToolRow = (
    part: (typeof entries)[number]["part"],
    key: string,
    opts: ToolActivityChildOptions
  ) => (
    <ToolCallRow
      key={key}
      part={part}
      expanded={opts.expanded}
      onToggle={opts.onToggle}
      defaultOpen={opts.forceOpen}
    />
  )
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
          <ToolCallRow part={entries[0].part} />
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
        <Link
          href={`/agent-teams?focus=subagent:${subagentId}`}
          className="inline-flex items-center gap-1 text-xs underline"
          data-testid="subagent-open"
        >
          {t("openInWorkspace")}
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
  const durationMs =
    part.completedAt != null ? part.completedAt - part.startedAt : now - part.startedAt

  const controlled = open !== undefined
  const [internalOpen, setInternalOpen] = useState(mode === "detailed")
  const isOpen = controlled ? (open as boolean) : internalOpen
  const toggle = () => {
    if (controlled) onToggle?.()
    else setInternalOpen((v) => !v)
  }

  const glyph = STATUS_GLYPH[status]
  const statusLabel = tStatus(cfg.labelKey)

  const rejectionBanner = rejection ? (
    <p
      className="mt-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
      data-testid="subagent-rejection"
    >
      {rejection.reason === "cycle" ? t("rejected.cycle") : t("rejected.maxDepth")}
    </p>
  ) : null

  // Simplified mode: one glanceable, borderless row (matches ToolCallRow's
  // Codex-style recession), expandable to the full detail body nested under a
  // left rule.
  if (mode === "simplified") {
    return (
      <div
        className="not-prose my-0.5"
        data-testid={`subagent-part-${part.subagentId}`}
        data-status={status}
      >
        <div className="flex items-center">
          <button
            type="button"
            onClick={toggle}
            aria-expanded={isOpen}
            aria-label={t("rowAria", { name: part.name, status: statusLabel })}
            data-testid={`subagent-toggle-${part.subagentId}`}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
          >
            <ChevronRightIcon
              className={cn(
                "size-3.5 shrink-0 opacity-60 transition-transform",
                isOpen && "rotate-90"
              )}
            />
            <BotIcon className="size-3.5 shrink-0" />
            <span className="shrink-0 font-medium text-foreground/80">{part.name}</span>
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
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {lastLog?.message ?? ""}
            </span>
            {typeof tokenTotal === "number" && tokenTotal > 0 ? (
              <Badge
                variant="outline"
                className="text-[10px] text-muted-foreground"
                data-testid="subagent-tokens-badge"
              >
                {t("tokens", { n: tokenTotal })}
              </Badge>
            ) : null}
            {isRunning && toolUses > 0 ? (
              <span
                className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
                data-testid="subagent-tools-count"
              >
                {t("toolsRunCount", { n: toolUses })}
              </span>
            ) : null}
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {t("durationMs", { ms: durationMs })}
            </span>
            <MotionStatusSwap swapKey={status} className="shrink-0">
              <glyph.Icon className={cn("size-3.5", glyph.className)} aria-hidden />
            </MotionStatusSwap>
            <span className="sr-only">{statusLabel}</span>
          </button>
          <BackgroundedRunControls
            variant="icon"
            isRunning={canAbort}
            onAbort={handleAbort}
            abortAria={t("abort")}
            abortTestId={`subagent-abort-${part.subagentId}`}
            className="mr-1"
          />
        </div>
        {rejectionBanner}
        <ReadingCollapse open={isOpen}>
          {/* ml aligns the left rule under the chevron (px-1.5 + half of size-3.5). */}
          <div className="ml-[13px] mb-1 space-y-2 border-l pl-3 pt-1">
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
        </ReadingCollapse>
      </div>
    )
  }

  // Standard / detailed: the full card with a controllable Collapsible.
  return (
    <div
      className="not-prose my-2 rounded-md border bg-card p-3"
      data-testid={`subagent-part-${part.subagentId}`}
      data-status={status}
    >
      <Collapsible open={isOpen}>
        <div className="flex items-center justify-between gap-2">
          <CollapsibleTrigger
            className="flex flex-1 items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
            data-testid={`subagent-toggle-${part.subagentId}`}
            onClick={toggle}
          >
            <glyph.Icon className={cn("size-3.5 shrink-0", glyph.className)} aria-hidden />
            <span className="text-sm font-medium">{part.name}</span>
            {typeof depth === "number" ? (
              <Badge variant="secondary" className="text-[10px]" data-testid="subagent-depth-badge">
                {t("depthBadge", { n: depth })}
              </Badge>
            ) : null}
            <Badge
              variant="outline"
              className={cn("text-[10px]", cfg.color)}
              data-testid="subagent-status-badge"
            >
              {statusLabel}
            </Badge>
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
                className="text-[10px] text-muted-foreground"
                data-testid="subagent-tokens-badge"
              >
                {t("tokens", { n: tokenTotal })}
              </Badge>
            ) : null}
            {isRunning && toolUses > 0 ? (
              <span
                className="ml-auto text-[11px] text-muted-foreground tabular-nums"
                data-testid="subagent-tools-count"
              >
                {t("toolsRunCount", { n: toolUses })}
              </span>
            ) : null}
            <span
              className={cn(
                "text-[11px] text-muted-foreground",
                !(isRunning && toolUses > 0) && "ml-auto"
              )}
            >
              {t("durationMs", { ms: durationMs })}
            </span>
          </CollapsibleTrigger>
          <BackgroundedRunControls
            variant="icon"
            isRunning={canAbort}
            onAbort={handleAbort}
            abortAria={t("abort")}
            abortTestId={`subagent-abort-${part.subagentId}`}
          />
        </div>
        {rejectionBanner}
        <CollapsibleContent className="mt-2 space-y-2">
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
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
})
