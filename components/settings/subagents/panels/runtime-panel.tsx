"use client"

/**
 * Live monitor for the ephemeral subagent run registry.
 *
 * Two things the previous tab could not do:
 *
 *  - It rendered a flat list, so the nesting the panel above it configures was
 *    invisible. Runs are now shown as the parent→child tree the records
 *    already describe (`runtime-tree.ts`).
 *  - It had no way to stop anything. Cancel is wired per row through the same
 *    entry point Chat uses, whether the runtime registered an AbortController
 *    or an SDK-native stop-task adapter.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { motion } from "motion/react"
import { ArrowRightIcon, ClockIcon, InfoIcon, TrashIcon, XCircleIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SettingsEmptyState, SettingsGroup } from "@/components/settings/common/settings-section"
import { toast } from "@/components/ui/sonner"
import { cn } from "@/lib/utils"
import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import { cancelSubagentRun } from "@/lib/claude/agents/cancel-subagent"
import { SUB_AGENT_STATUS_CONFIG } from "@/types/agent/sub-agent"
import type { SubAgent } from "@/types/agent/sub-agent"

import { RollingNumber } from "../motion/rolling-number"
import {
  buildRuntimeTree,
  flattenRuntimeTree,
  isRunning,
  isTerminal,
  terminalRunIds,
} from "../runtime-tree"

/** Format milliseconds into a human-readable duration. */
export function formatDuration(ms: number): string {
  const clamped = Math.max(0, ms)
  if (clamped < 1000) return `${clamped}ms`
  if (clamped < 60_000) return `${Math.round(clamped / 1000)}s`
  const minutes = Math.floor(clamped / 60_000)
  const seconds = Math.round((clamped % 60_000) / 1000)
  if (minutes < 60) return `${minutes}m ${seconds}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function RuntimePanel() {
  const t = useTranslations("settings.subagents.runtime")
  const tStatus = useTranslations("agentStatus")
  const { reduce } = useFlowMotion()

  const subAgents = useSubagentRuntimeStore((s) => s.subAgents)
  const remove = useSubagentRuntimeStore((s) => s.remove)

  const runs = useMemo(() => Object.values(subAgents), [subAgents])
  const nodes = useMemo(() => flattenRuntimeTree(buildRuntimeTree(runs)), [runs])
  const anyRunning = useMemo(() => runs.some(isRunning), [runs])
  const finishedIds = useMemo(() => terminalRunIds(runs), [runs])

  // Only tick while something is actually live — an idle panel must not keep
  // waking the renderer.
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    if (!anyRunning) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [anyRunning])

  const cancel = useCallback(
    (run: SubAgent) => {
      const signalled = cancelSubagentRun(run.id, { reason: "Cancelled from settings" })
      if (signalled) toast.success(t("cancelRequested", { name: run.name }))
      else toast.info(t("cancelUnreachable"))
    },
    [t]
  )

  const callout = (
    <Alert data-testid="subagent-runtime-callout">
      <InfoIcon />
      <AlertTitle>{t("callout.title")}</AlertTitle>
      <AlertDescription>
        <p>{t("callout.body")}</p>
        <Button variant="link" size="sm" className="h-auto p-0 text-xs" asChild>
          <Link href="/agent-teams">
            {t("callout.cta")}
            <ArrowRightIcon className="ml-1 size-3" />
          </Link>
        </Button>
      </AlertDescription>
    </Alert>
  )

  if (nodes.length === 0) {
    return (
      <div className="space-y-3" data-testid="subagent-runtime-empty">
        <Header t={t} />
        {callout}
        <SettingsEmptyState
          icon={<ClockIcon className="size-5" />}
          title={t("emptyTitle")}
          description={t("emptyBody")}
        />
      </div>
    )
  }

  return (
    <div className="space-y-3" data-testid="subagent-runtime-list">
      <div className="flex items-start justify-between gap-3">
        <Header t={t} />
        {finishedIds.length > 0 ? (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            // Explicit arrow, not a bare `forEach(remove)`: the latter hands
            // the store the index and the array as extra arguments.
            onClick={() => finishedIds.forEach((id) => remove(id))}
            data-testid="subagent-runtime-clear-finished"
          >
            <TrashIcon className="mr-1.5 size-3.5" />
            {t("clearFinished", { count: finishedIds.length })}
          </Button>
        ) : null}
      </div>
      {callout}

      <motion.div
        className="space-y-1.5"
        role="tree"
        aria-label={t("title")}
        variants={reduce ? undefined : STAGGER_CONTAINER}
        initial={reduce ? undefined : "hidden"}
        animate={reduce ? undefined : "visible"}
      >
        {nodes.map(({ run, depth }) => (
          <RunRow
            key={run.id}
            run={run}
            depth={depth}
            now={now}
            reduce={reduce}
            onCancel={() => cancel(run)}
            onRemove={() => remove(run.id)}
            t={t}
            tStatus={tStatus}
          />
        ))}
      </motion.div>
    </div>
  )
}

function Header({ t }: { t: ReturnType<typeof useTranslations> }) {
  return (
    <div className="space-y-0.5">
      <h3 className="text-sm font-medium">{t("title")}</h3>
      <p className="text-xs text-muted-foreground">{t("description")}</p>
    </div>
  )
}

function RunRow({
  run,
  depth,
  now,
  reduce,
  onCancel,
  onRemove,
  t,
  tStatus,
}: {
  run: SubAgent
  depth: number
  now: number
  reduce: boolean
  onCancel: () => void
  onRemove: () => void
  t: ReturnType<typeof useTranslations>
  tStatus: ReturnType<typeof useTranslations>
}) {
  const statusCfg = SUB_AGENT_STATUS_CONFIG[run.status]
  const startedAt = run.startedAt instanceof Date ? run.startedAt.getTime() : null
  const completedAt = run.completedAt instanceof Date ? run.completedAt.getTime() : null
  const durationMs = startedAt !== null ? (completedAt ?? now) - startedAt : null
  const terminal = isTerminal(run.status)
  const recentLogs = run.logs.slice(-3)

  return (
    <motion.div
      variants={reduce ? undefined : STAGGER_CHILD}
      role="treeitem"
      aria-level={depth + 1}
      data-testid={`subagent-runtime-row-${run.id}`}
      data-status={run.status}
      data-depth={depth}
      className="rounded-md border p-2.5"
      style={{ marginLeft: depth * 16 }}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium">{run.name}</span>
            <Badge
              variant={
                run.status === "failed" || run.status === "timeout"
                  ? "destructive"
                  : run.status === "completed"
                    ? "default"
                    : "secondary"
              }
              className="text-[10px]"
            >
              {tStatus(statusCfg.labelKey)}
            </Badge>
            {depth > 0 ? (
              <Badge variant="outline" className="text-[10px]">
                {t("depthBadge", { depth: depth + 1 })}
              </Badge>
            ) : null}
            {run.backgrounded ? (
              <Badge variant="outline" className="text-[10px]">
                {t("backgrounded")}
              </Badge>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] tabular-nums text-muted-foreground">
            {durationMs !== null ? <span>{formatDuration(durationMs)}</span> : null}
            {(run.toolUses ?? 0) > 0 ? (
              <span data-testid={`subagent-runtime-tools-${run.id}`}>
                {t("toolsRunCount", { n: run.toolUses ?? 0 })}
              </span>
            ) : null}
            {run.tokenUsage ? (
              <span className="flex items-center gap-1">
                <RollingNumber
                  value={run.tokenUsage.totalTokens}
                  data-testid={`subagent-runtime-tokens-${run.id}`}
                />
                <span>{t("tokensSuffix")}</span>
              </span>
            ) : null}
            {run.config?.model ? <span>{run.config.model}</span> : null}
          </div>

          {run.rejection ? (
            <p className="text-[11px] text-destructive" data-testid={`rejection-${run.id}`}>
              {run.rejection.message}
            </p>
          ) : null}
          {run.error ? (
            <p className="line-clamp-2 text-[11px] text-destructive">{run.error}</p>
          ) : null}

          {recentLogs.length > 0 ? (
            <div className="space-y-0.5">
              {recentLogs.map((logEntry, i) => (
                <p key={i} className="line-clamp-1 font-mono text-[11px] text-muted-foreground">
                  <span className="mr-1 uppercase">[{logEntry.level}]</span>
                  {logEntry.message}
                </p>
              ))}
            </div>
          ) : null}

          {run.logs.length > 3 ? (
            <SettingsGroup title={t("allLogs", { count: run.logs.length })} defaultOpen={false}>
              <div className="max-h-40 space-y-0.5 overflow-y-auto font-mono text-[11px]">
                {run.logs.map((logEntry, i) => (
                  <p key={i} className="text-muted-foreground">
                    <span className="mr-1 uppercase">[{logEntry.level}]</span>
                    {logEntry.message}
                  </p>
                ))}
              </div>
            </SettingsGroup>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {terminal ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={onRemove}
              aria-label={t("removeAria", { name: run.name })}
              data-testid={`subagent-runtime-remove-${run.id}`}
            >
              <TrashIcon className="size-3.5" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className={cn("size-7", "text-destructive hover:text-destructive")}
              onClick={onCancel}
              aria-label={t("cancelAria", { name: run.name })}
              data-testid={`subagent-runtime-cancel-${run.id}`}
            >
              <XCircleIcon className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </motion.div>
  )
}
