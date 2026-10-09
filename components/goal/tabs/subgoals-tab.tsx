"use client"

/**
 * Subgoals tab (subgoal decomposition). Generates an ordered checklist from the
 * goal's redacted objective via one LLM call, persists it, and renders it with
 * manual toggles + a progress bar. The judge can also auto-mark steps complete
 * over the loop (see `turn-driver`). Subscribes to the live goal row so checks
 * land immediately whether toggled here or by the judge.
 *
 * "Clear" removes the checklist (`clearSubgoals`), which used to be reachable
 * only from the plugin API and the workflow node.
 *
 * Every write goes through `useGoalControls`, so on a paired phone the
 * checklist is generated, checked and cleared ON THE DESKTOP that runs the
 * loop (`goal_subgoals_generate` / `goal_subgoal_mark` / `goal_subgoals_clear`),
 * with the desktop's model and key and behind its PII gate, and only by a
 * device holding the remote-control grant; the result reaches this device on
 * the goal row's sync, which the live query below already follows.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { motion } from "motion/react"
import { EraserIcon, Loader2Icon, SparklesIcon } from "lucide-react"

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
import { Checkbox } from "@/components/ui/checkbox"
import { Progress } from "@/components/ui/progress"
import { useGoalControls } from "@/hooks/goal/use-goal-controls"
import { getGoal } from "@/lib/db/goals"
import { STAGGER_CHILD, STAGGER_CONTAINER, useReducedMotionVariants } from "@/lib/ui/motion"
import type { Goal } from "@/types/goal"

interface Props {
  goal: Goal
}

export function GoalSubgoalsTab({ goal }: Props) {
  const t = useTranslations("goal")
  const controls = useGoalControls(goal)
  // A paired phone without the remote-control grant sees the checklist but
  // cannot change it (the desktop would refuse every write).
  const readOnly = !controls.allowed
  const containerVariants = useReducedMotionVariants(STAGGER_CONTAINER)
  const childVariants = useReducedMotionVariants(STAGGER_CHILD)

  // Live-bind so judge-driven completions + manual toggles both reflect at once.
  const live = useLiveQuery(() => getGoal(goal.id), [goal.id])
  const current = live ?? goal
  const subgoals = current.subgoals ?? []

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  // Distinct from `error`: no model with a usable API key is resolvable, so
  // retrying can't succeed. Renders the non-retryable `unavailable` copy.
  const [unavailable, setUnavailable] = useState(false)
  // Companion only: the desktop answered before its model did. The checklist
  // lands on the synced goal row; cleared on the next generate.
  const [running, setRunning] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  const done = subgoals.filter((s) => s.done).length
  const total = subgoals.length
  const pct = total > 0 ? (done / total) * 100 : 0

  async function generate() {
    setBusy(true)
    setError(false)
    setUnavailable(false)
    setRunning(false)
    try {
      const outcome = await controls.generateSubgoals()
      // No resolvable model/API key on the host that runs the loop: the
      // non-retryable reason instead of the generic "try again" error.
      if (outcome === "unavailable") setUnavailable(true)
      else if (outcome === "running") setRunning(true)
      // Fail-OPEN decomposition (nothing parseable, prior checklist kept), a
      // goal deleted underneath, or a failed call: retryable.
      else if (outcome !== "generated") setError(true)
    } finally {
      setBusy(false)
    }
  }

  const hasSubgoals = total > 0

  async function clear() {
    setConfirmClear(false)
    // Failures are reported by the verb (under "Couldn't clear the checklist"
    // here, as the remote message on a phone).
    await controls.clearSubgoals()
  }

  async function toggle(subgoalId: string, done: boolean) {
    // The wanted state, not a flip: a retried companion call cannot undo it.
    await controls.setSubgoalDone(subgoalId, done)
  }

  return (
    <div className="space-y-4" data-testid="goal-subgoals-tab">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t("subgoals.title")}</p>
          <p className="text-xs text-muted-foreground">{t("subgoals.description")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {hasSubgoals ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmClear(true)}
              disabled={busy || readOnly}
              data-testid="goal-subgoals-clear"
            >
              <EraserIcon className="size-4" aria-hidden />
              {t("subgoals.clear")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={hasSubgoals ? "outline" : "default"}
            onClick={() => void generate()}
            disabled={busy || readOnly}
            data-testid="goal-subgoals-generate"
          >
            {busy ? (
              <Loader2Icon className="size-4 animate-spin" aria-hidden />
            ) : (
              <SparklesIcon className="size-4" aria-hidden />
            )}
            {busy
              ? t("subgoals.generating")
              : hasSubgoals
                ? t("subgoals.regenerate")
                : t("subgoals.generate")}
          </Button>
        </div>
      </div>

      {readOnly && (
        <p className="text-xs text-muted-foreground" data-testid="goal-subgoals-read-only">
          {t("subgoals.remoteNotAllowed")}
        </p>
      )}

      {running && (
        <p className="text-xs text-muted-foreground" data-testid="goal-subgoals-running">
          {t("subgoals.running")}
        </p>
      )}

      {error && (
        <p className="text-xs text-destructive" data-testid="goal-subgoals-error">
          {t("subgoals.error")}
        </p>
      )}

      {unavailable && (
        <p
          className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground"
          data-testid="goal-subgoals-unavailable"
        >
          {t("subgoals.unavailable")}
        </p>
      )}

      {hasSubgoals ? (
        <>
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t("subgoals.progress", { done, total })}</span>
              <span className="tabular-nums">{Math.round(pct)}%</span>
            </div>
            <Progress value={pct} data-testid="goal-subgoals-progress" />
          </div>
          <motion.ul
            className="divide-y divide-border/60 border-y border-border/60"
            variants={containerVariants}
            initial="initial"
            animate="animate"
            data-testid="goal-subgoals-list"
          >
            {subgoals.map((s) => (
              <motion.li
                key={s.id}
                variants={childVariants}
                className="flex items-start gap-2.5 py-2"
                data-testid="goal-subgoal-item"
              >
                <Checkbox
                  checked={s.done}
                  onCheckedChange={(checked) => void toggle(s.id, checked === true)}
                  disabled={readOnly}
                  aria-label={s.text}
                  className="mt-0.5"
                  data-testid="goal-subgoal-checkbox"
                />
                <span className={s.done ? "text-sm text-muted-foreground line-through" : "text-sm"}>
                  {s.text}
                </span>
              </motion.li>
            ))}
          </motion.ul>
        </>
      ) : (
        !error &&
        !unavailable &&
        !running && (
          <p
            className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground"
            data-testid="goal-subgoals-empty"
          >
            {t("subgoals.empty")}
          </p>
        )
      )}
      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent data-testid="goal-subgoals-clear-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("subgoals.clearTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("subgoals.clearBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("history.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void clear()}
              data-testid="goal-subgoals-clear-confirm"
            >
              {t("subgoals.clear")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
