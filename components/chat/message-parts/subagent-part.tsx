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

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
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
import { Progress } from "@/components/ui/progress"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import type { SubagentPart as SubagentPartType } from "@/lib/claude/parts-extensions"
import { SUB_AGENT_STATUS_CONFIG } from "@/types/agent/sub-agent"
import type { AgentFlowMode } from "@/types/appearance"
import { MotionCollapse, MotionStatusSwap } from "@/components/chat/motion/motion-reveal"
import { cn } from "@/lib/utils"

/** Status → concrete glyph for the simplified row + card header. */
const STATUS_GLYPH: Record<string, { Icon: LucideIcon; className: string }> = {
  pending: { Icon: CircleIcon, className: "text-muted-foreground" },
  queued: { Icon: ClockIcon, className: "text-blue-500" },
  running: { Icon: Loader2Icon, className: "animate-spin text-primary" },
  waiting: { Icon: PauseIcon, className: "text-yellow-500" },
  completed: { Icon: CheckCircleIcon, className: "text-green-600" },
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

export function SubagentPart({ part, mode = "standard", open, onToggle }: Props) {
  const t = useTranslations("chat.subagentPart")
  const tStatus = useTranslations("agentStatus")
  // Live read for progress + logs; falls back to the static part snapshot.
  const live = useSubagentRuntimeStore((s) => s.subAgents[part.subagentId])

  const status = live?.status ?? part.status
  const progress = live?.progress ?? part.progress
  const cfg = SUB_AGENT_STATUS_CONFIG[status]
  const logs = live?.logs ?? []
  const lastLog = logs[logs.length - 1]
  const rejection = live?.rejection ?? part.rejection
  const backgrounded = (live?.backgrounded ?? part.backgrounded) === true && status === "running"
  const depth = live?.depth ?? part.depth
  const tokenTotal = (live?.result?.tokenUsage ?? part.tokenUsage)?.totalTokens
  const isRunning = part.completedAt == null && status === "running"
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

  const detailBody = (
    <>
      <Progress value={progress} className="h-1.5" />
      {part.summary ? <p className="rounded bg-muted/30 p-2 text-xs">{part.summary}</p> : null}
      {logs.length > 0 ? (
        <div className="space-y-0.5" data-testid="subagent-logs">
          {logs.slice(-50).map((log, i) => (
            <p key={i} className="font-mono text-[11px] text-muted-foreground">
              <span className="mr-1 uppercase">[{log.level}]</span>
              {log.message}
            </p>
          ))}
        </div>
      ) : lastLog ? (
        <p className="font-mono text-[11px] text-muted-foreground">{lastLog.message}</p>
      ) : (
        <p className="text-[11px] italic text-muted-foreground">{t("noLogsYet")}</p>
      )}
      <Link
        href={`/agent-teams?focus=subagent:${part.subagentId}`}
        className="inline-flex items-center gap-1 text-xs underline"
        data-testid="subagent-open"
      >
        {t("openInWorkspace")}
        <ExternalLinkIcon className="size-3" />
      </Link>
    </>
  )

  // Simplified mode: one glanceable row, expandable to the full detail body.
  if (mode === "simplified") {
    return (
      <div
        className="not-prose my-1 rounded-md border bg-card"
        data-testid={`subagent-part-${part.subagentId}`}
        data-status={status}
      >
        <button
          type="button"
          onClick={toggle}
          aria-expanded={isOpen}
          aria-label={t("rowAria", { name: part.name, status: statusLabel })}
          data-testid={`subagent-toggle-${part.subagentId}`}
          className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted/50"
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              isOpen && "rotate-90"
            )}
          />
          <BotIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="shrink-0 font-medium">{part.name}</span>
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
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {t("durationMs", { ms: durationMs })}
          </span>
          <MotionStatusSwap swapKey={status} className="shrink-0">
            <glyph.Icon className={cn("size-3.5", glyph.className)} aria-hidden />
          </MotionStatusSwap>
          <span className="sr-only">{statusLabel}</span>
        </button>
        {rejectionBanner}
        <MotionCollapse open={isOpen}>
          <div className="space-y-2 border-t px-3 py-2.5">{detailBody}</div>
        </MotionCollapse>
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
            className="flex flex-1 items-center gap-2 text-left"
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
            {typeof tokenTotal === "number" && tokenTotal > 0 ? (
              <Badge
                variant="outline"
                className="text-[10px] text-muted-foreground"
                data-testid="subagent-tokens-badge"
              >
                {t("tokens", { n: tokenTotal })}
              </Badge>
            ) : null}
            <span className="ml-auto text-[11px] text-muted-foreground">
              {t("durationMs", { ms: durationMs })}
            </span>
          </CollapsibleTrigger>
        </div>
        {rejectionBanner}
        <Progress value={progress} className="mt-2 h-1.5" />
        <CollapsibleContent className="mt-2 space-y-2">
          {part.summary ? <p className="rounded bg-muted/30 p-2 text-xs">{part.summary}</p> : null}
          {logs.length > 0 ? (
            <div className="space-y-0.5" data-testid="subagent-logs">
              {logs.slice(-50).map((log, i) => (
                <p key={i} className="font-mono text-[11px] text-muted-foreground">
                  <span className="mr-1 uppercase">[{log.level}]</span>
                  {log.message}
                </p>
              ))}
            </div>
          ) : lastLog ? (
            <p className="font-mono text-[11px] text-muted-foreground">{lastLog.message}</p>
          ) : (
            <p className="text-[11px] italic text-muted-foreground">{t("noLogsYet")}</p>
          )}
          <Link
            href={`/agent-teams?focus=subagent:${part.subagentId}`}
            className="inline-flex items-center gap-1 text-xs underline"
            data-testid="subagent-open"
          >
            {t("openInWorkspace")}
            <ExternalLinkIcon className="size-3" />
          </Link>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
