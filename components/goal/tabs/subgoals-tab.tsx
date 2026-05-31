"use client"

/**
 * Subgoals tab (subgoal decomposition). Generates an ordered checklist from the
 * goal's redacted objective via one LLM call, persists it, and renders it with
 * manual toggles + a progress bar. The judge can also auto-mark steps complete
 * over the loop (see `turn-driver`). Subscribes to the live goal row so checks
 * land immediately whether toggled here or by the judge.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { motion } from "motion/react"
import { Loader2Icon, SparklesIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Progress } from "@/components/ui/progress"
import { getGoal } from "@/lib/db/goals"
import { getSession } from "@/lib/db/sessions"
import { getGoalRuntime } from "@/lib/goal/runtime"
import { buildRendererLlmClient } from "@/lib/ai/renderer-llm-client"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { STAGGER_CHILD, STAGGER_CONTAINER, useReducedMotionVariants } from "@/lib/ui/motion"
import type { Goal } from "@/types/goal"

interface Props {
  goal: Goal
}

export function GoalSubgoalsTab({ goal }: Props) {
  const t = useTranslations("goal")
  const appSettings = useSettingsStore((s) => s.settings)
  const containerVariants = useReducedMotionVariants(STAGGER_CONTAINER)
  const childVariants = useReducedMotionVariants(STAGGER_CHILD)

  // Live-bind so judge-driven completions + manual toggles both reflect at once.
  const live = useLiveQuery(() => getGoal(goal.id), [goal.id])
  const current = live ?? goal
  const subgoals = current.subgoals ?? []

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  const done = subgoals.filter((s) => s.done).length
  const total = subgoals.length
  const pct = total > 0 ? (done / total) * 100 : 0

  async function generate() {
    setBusy(true)
    setError(false)
    try {
      const session = await getSession(current.sessionId)
      const client = buildRendererLlmClient({
        session,
        appSettings,
        featureId: "goal-subgoals",
      })
      if (!client) {
        setError(true)
        return
      }
      const updated = await getGoalRuntime().generateSubgoals(current.id, client)
      // Fail-OPEN: decomposition returns an empty checklist when the model
      // produced nothing parseable — surface that as a retryable error.
      if ((updated?.subgoals?.length ?? 0) === 0) setError(true)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  const hasSubgoals = total > 0

  return (
    <div className="space-y-4" data-testid="goal-subgoals-tab">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t("subgoals.title")}</p>
          <p className="text-xs text-muted-foreground">{t("subgoals.description")}</p>
        </div>
        <Button
          size="sm"
          variant={hasSubgoals ? "outline" : "default"}
          onClick={() => void generate()}
          disabled={busy}
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

      {error && (
        <p className="text-xs text-destructive" data-testid="goal-subgoals-error">
          {t("subgoals.error")}
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
            className="space-y-1.5"
            variants={containerVariants}
            initial="initial"
            animate="animate"
            data-testid="goal-subgoals-list"
          >
            {subgoals.map((s) => (
              <motion.li
                key={s.id}
                variants={childVariants}
                className="flex items-start gap-2 rounded-md border bg-card/50 px-3 py-2"
                data-testid="goal-subgoal-item"
              >
                <Checkbox
                  checked={s.done}
                  onCheckedChange={() => void getGoalRuntime().toggleSubgoal(current.id, s.id)}
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
        !error && (
          <p
            className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground"
            data-testid="goal-subgoals-empty"
          >
            {t("subgoals.empty")}
          </p>
        )
      )}
    </div>
  )
}
