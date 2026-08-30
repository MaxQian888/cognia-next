"use client"

/**
 * The history backfill control, in Settings, Memory, Project context.
 *
 * A sweep of a workspace's whole conversation history costs real money on the
 * user's own key or subscription, so this never starts one on its own. It
 * proposes a run, shows what the run would cost, and waits. `preconsent` is a
 * real state on the row rather than a dialog flag, which is what makes "I
 * closed the window before deciding" resumable instead of forgotten.
 *
 * Progress is polled rather than live-queried. A backfill advances once per
 * idle tick, so a `liveQuery` subscription would re-render this card far more
 * often than the numbers on it change.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import type { ProjectMiningRun } from "@/types/memory/governance"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"

export interface ProjectBackfillCardProps {
  projectId: string | undefined
  /** Injected so the card renders in tests and Storybook without Dexie. */
  service?: ProjectBackfillService
  /** Poll interval. Zero disables polling, which is what tests want. */
  pollMs?: number
}

export interface ProjectBackfillService {
  load: (projectId: string) => Promise<ProjectMiningRun | undefined>
  propose: (projectId: string) => Promise<ProjectMiningRun>
  confirm: (runId: string) => Promise<unknown>
  pause: (runId: string) => Promise<unknown>
  resume: (runId: string) => Promise<unknown>
  cancel: (runId: string) => Promise<unknown>
}

const DEFAULT_POLL_MS = 15_000

function defaultService(): ProjectBackfillService {
  const load = async (projectId: string) => {
    const { getActiveProjectMiningRun } = await import("@/lib/db/project-mining-runs")
    return getActiveProjectMiningRun(projectId)
  }
  return {
    load,
    propose: async (projectId) => {
      const { proposeWorkspaceBackfill } = await import("@/lib/memory/backfill/backfill-service")
      return proposeWorkspaceBackfill(projectId)
    },
    confirm: async (runId) => {
      const { confirmWorkspaceBackfill } = await import("@/lib/memory/backfill/backfill-service")
      return confirmWorkspaceBackfill(runId)
    },
    pause: async (runId) => {
      const { pauseWorkspaceBackfill } = await import("@/lib/memory/backfill/backfill-service")
      return pauseWorkspaceBackfill(runId)
    },
    resume: async (runId) => {
      const { resumeWorkspaceBackfill } = await import("@/lib/memory/backfill/backfill-service")
      return resumeWorkspaceBackfill(runId)
    },
    cancel: async (runId) => {
      const { cancelWorkspaceBackfill } = await import("@/lib/memory/backfill/backfill-service")
      return cancelWorkspaceBackfill(runId)
    },
  }
}

export function ProjectBackfillCard({
  projectId,
  service,
  pollMs = DEFAULT_POLL_MS,
}: ProjectBackfillCardProps) {
  const t = useTranslations("settings.memory.projectContext.backfill")
  const [run, setRun] = useState<ProjectMiningRun | undefined>()
  const [busy, setBusy] = useState(false)
  // Bumped after an action so the card re-reads without waiting out the poll.
  const [reloadToken, setReloadToken] = useState(0)
  const api = service ?? defaultService()
  const load = api.load

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    const read = async () => {
      const next = await load(projectId).catch(() => undefined)
      if (!cancelled) setRun(next)
    }
    void read()
    const timer = pollMs > 0 ? setInterval(() => void read(), pollMs) : undefined
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
    // `load` is stable for the default service (a module-level closure) and
    // caller-owned otherwise; `reloadToken` is the explicit refresh signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, pollMs, reloadToken])

  const act = useCallback(
    async (fn: () => Promise<unknown>, failureKey: string) => {
      setBusy(true)
      try {
        await fn()
        setReloadToken((token) => token + 1)
      } catch {
        toast.error(t(failureKey))
      } finally {
        setBusy(false)
      }
    },
    [t]
  )

  if (!projectId) {
    return (
      <div className="rounded-md border p-3" data-testid="memory-backfill-card">
        <p className="text-xs font-medium">{t("title")}</p>
        <p className="mt-1 text-[11px] text-muted-foreground">{t("noWorkspace")}</p>
      </div>
    )
  }

  const status = run?.status
  const progress =
    run && run.estimate.sessions > 0
      ? Math.min(100, Math.round((run.sessionsScanned / run.estimate.sessions) * 100))
      : null

  return (
    <div className="rounded-md border p-3" data-testid="memory-backfill-card" data-status={status}>
      <p className="text-xs font-medium">{t("title")}</p>

      {!run ? (
        <>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {t("description")}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2 h-7 px-2 text-xs"
            disabled={busy}
            data-testid="memory-backfill-propose"
            onClick={() => void act(() => api.propose(projectId), "proposeFailed")}
          >
            {t("propose")}
          </Button>
        </>
      ) : null}

      {run && status === "preconsent" ? (
        <>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {t("estimate", {
              sessions: run.estimate.sessions,
              calls: run.estimate.windows,
              tokens: run.estimate.estimatedInputTokens,
            })}
          </p>
          {/*
            The estimate is honest in both directions and says so. Salience
            rejects some windows before they reach a model, and a conversation
            full of long tool output beats the per-message average.
          */}
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {t("estimateCaveat")}
          </p>
          <div className="mt-2 flex gap-1.5">
            <Button
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={busy}
              data-testid="memory-backfill-confirm"
              onClick={() => void act(() => api.confirm(run.id), "confirmFailed")}
            >
              {t("confirm")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={busy}
              data-testid="memory-backfill-cancel"
              onClick={() => void act(() => api.cancel(run.id), "cancelFailed")}
            >
              {t("discard")}
            </Button>
          </div>
        </>
      ) : null}

      {run && (status === "queued" || status === "running" || status === "paused") ? (
        <>
          <p
            className="mt-1 text-[11px] text-muted-foreground"
            data-testid="memory-backfill-progress"
          >
            {t("progress", {
              scanned: run.sessionsScanned,
              total: run.estimate.sessions,
              claims: run.claimsProduced,
            })}
          </p>
          {progress !== null ? <Progress value={progress} className="mt-2 h-1.5" /> : null}
          <div className="mt-2 flex gap-1.5">
            {status === "paused" ? (
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                disabled={busy}
                data-testid="memory-backfill-resume"
                onClick={() => void act(() => api.resume(run.id), "resumeFailed")}
              >
                {t("resume")}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                disabled={busy}
                data-testid="memory-backfill-pause"
                onClick={() => void act(() => api.pause(run.id), "pauseFailed")}
              >
                {t("pause")}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={busy}
              data-testid="memory-backfill-cancel"
              onClick={() => void act(() => api.cancel(run.id), "cancelFailed")}
            >
              {t("cancel")}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  )
}
