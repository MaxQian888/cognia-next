"use client"

import { useCallback, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { getExecutionBroker } from "@/lib/execution/broker"
import { retryAppliedCogset, switchCogset } from "@/lib/plugin/cogset/actions"
import type {
  CogsetActivationProgress,
  CogsetActivationResult,
} from "@/lib/plugin/cogset/reconcile"
import type { CogsetRow } from "@/types/plugin/plugin-cogset"

import { CogsetOutcomeList } from "./cogset-outcome-list"

interface Running {
  name: string
  progress: CogsetActivationProgress
}

interface Finished {
  name: string
  result: CogsetActivationResult
}

export interface CogsetSwitchController {
  /** Switch to `cogset`, asking first when agent runs are in flight. */
  request: (cogset: CogsetRow) => void
  /** Re-run the applied cogset, with the same progress and result display. */
  retry: (name: string) => void
  /** The confirm, progress and result dialogs. Render once. */
  element: ReactNode
}

/**
 * The switch flow shared by the toolbar switcher and the manager: confirm when
 * agents are running (disabling plugins under a live turn breaks its tools),
 * show progress while plugins turn on and off, then either a toast or — when
 * the switch was partial — the per-plugin result with Retry.
 */
export function useCogsetSwitch(options: {
  displayName: (cogset: Pick<CogsetRow, "name" | "source">) => string
  pluginName: (pluginId: string) => string
}): CogsetSwitchController {
  const t = useTranslations("plugins.cogsets")
  const [confirming, setConfirming] = useState<CogsetRow | null>(null)
  const [running, setRunning] = useState<Running | null>(null)
  const [finished, setFinished] = useState<Finished | null>(null)

  const settle = useCallback(
    (name: string, result: CogsetActivationResult | null | undefined) => {
      setRunning(null)
      if (!result) return
      if (result.applied.status === "applied") toast.success(t("switcher.switched", { name }))
      else setFinished({ name, result })
    },
    [t]
  )

  const run = useCallback(
    async (cogset: CogsetRow) => {
      const name = options.displayName(cogset)
      setFinished(null)
      setRunning({ name, progress: { done: 0, total: 0 } })
      try {
        const outcome = await switchCogset(cogset.id, {
          onProgress: (progress) => setRunning({ name, progress }),
        })
        if (outcome.queued) {
          setRunning(null)
          toast.success(t("switcher.queued", { name }))
          return
        }
        settle(name, outcome.result)
      } catch (error) {
        setRunning(null)
        toast.error(t("switcher.switchFailed", { name }), {
          description: error instanceof Error ? error.message : String(error),
        })
      }
    },
    [options, settle, t]
  )

  const retry = useCallback(
    async (retryName?: string) => {
      const name = retryName ?? finished?.name ?? ""
      setFinished(null)
      setRunning({ name, progress: { done: 0, total: 0 } })
      try {
        settle(
          name,
          await retryAppliedCogset({ onProgress: (progress) => setRunning({ name, progress }) })
        )
      } catch (error) {
        setRunning(null)
        toast.error(t("switcher.switchFailed", { name }), {
          description: error instanceof Error ? error.message : String(error),
        })
      }
    },
    [finished, settle, t]
  )

  const request = useCallback(
    (cogset: CogsetRow) => {
      if (getExecutionBroker().list().length > 0) setConfirming(cogset)
      else void run(cogset)
    },
    [run]
  )

  const percent =
    running && running.progress.total > 0
      ? Math.round((running.progress.done / running.progress.total) * 100)
      : 0

  const element = (
    <>
      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmRuns.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirming
                ? t("confirmRuns.description", { name: options.displayName(confirming) })
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("confirmRuns.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="cogset-confirm-switch"
              onClick={() => {
                const target = confirming
                setConfirming(null)
                if (target) void run(target)
              }}
            >
              {t("confirmRuns.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={running !== null}>
        <DialogContent className="w-[95vw] max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("activation.title", { name: running?.name ?? "" })}</DialogTitle>
            <DialogDescription>
              {t("activation.progress", {
                done: running?.progress.done ?? 0,
                total: running?.progress.total ?? 0,
              })}
            </DialogDescription>
          </DialogHeader>
          <Progress
            value={percent}
            aria-label={t("activation.title", { name: running?.name ?? "" })}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={finished !== null} onOpenChange={(open) => !open && setFinished(null)}>
        <DialogContent className="flex max-h-[85dvh] w-[95vw] max-w-lg flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle>
              {t("activation.partialTitle", { name: finished?.name ?? "" })}
            </DialogTitle>
            <DialogDescription>{t("activation.partialDescription")}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {finished && (
              <CogsetOutcomeList
                outcomes={finished.result.applied.outcomes}
                pluginName={options.pluginName}
              />
            )}
          </div>
          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => setFinished(null)}>
              {t("activation.close")}
            </Button>
            <Button onClick={() => void retry()} data-testid="cogset-retry">
              {t("activation.retry")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )

  return { request, retry: (name) => void retry(name), element }
}
