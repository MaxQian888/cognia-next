"use client"

/**
 * Drives the nine-step executor from the workbench (ADR-0117, Phase 3).
 *
 * Holds the per-process `CreatorRunState` — the plan and its file contents,
 * which deliberately never reach the durable log — and hands it back to the
 * executor on each advance. Progress itself is read from the log by the
 * workbench, so this hook is not a second source of truth for it: it carries
 * only what the log must not.
 */

import { useCallback, useRef, useState } from "react"

import { createCreatorRunState, runCreatorPipeline, runCreatorStep } from "@/lib/creator/executor"
import type {
  CreatorHandlers,
  CreatorRunContext,
  CreatorRunState,
  PipelineOutcome,
} from "@/lib/creator/executor"
import { createCreatorRunLog } from "@/lib/creator/run-log"
import type { CreatorAdvanceState } from "@/lib/creator/steps"
import type { CreatorStepId } from "@/types/creator"

export interface UseCreatorRunOptions {
  handlers: CreatorHandlers
}

export interface CreatorRunController {
  /** The step currently executing, for the rail's spinner. */
  activeStep: CreatorStepId | null
  busy: boolean
  lastOutcome: PipelineOutcome | null
  /** Run forward until the workflow needs the user. */
  advance: (ctx: CreatorRunContext, progress: CreatorAdvanceState) => Promise<void>
  /** Run exactly one step, for the per-step control. */
  step: (
    step: CreatorStepId,
    ctx: CreatorRunContext,
    progress: CreatorAdvanceState
  ) => Promise<void>
  /** Drop the carried plan, e.g. when the run ends or the root changes. */
  reset: () => void
}

export function useCreatorRun({ handlers }: UseCreatorRunOptions): CreatorRunController {
  const runState = useRef<CreatorRunState>(createCreatorRunState())
  const [activeStep, setActiveStep] = useState<CreatorStepId | null>(null)
  const [busy, setBusy] = useState(false)
  const [lastOutcome, setLastOutcome] = useState<PipelineOutcome | null>(null)

  const advance = useCallback(
    async (ctx: CreatorRunContext, progress: CreatorAdvanceState) => {
      if (busy) return
      setBusy(true)
      try {
        const outcome = await runCreatorPipeline({
          ctx,
          handlers,
          progress,
          run: runState.current,
          log: createCreatorRunLog(ctx.runId),
        })
        setLastOutcome(outcome)
      } finally {
        setBusy(false)
        setActiveStep(null)
      }
    },
    [busy, handlers]
  )

  const step = useCallback(
    async (id: CreatorStepId, ctx: CreatorRunContext, progress: CreatorAdvanceState) => {
      if (busy) return
      setBusy(true)
      setActiveStep(id)
      try {
        const outcome = await runCreatorStep(id, {
          ctx,
          handlers,
          progress,
          run: runState.current,
          log: createCreatorRunLog(ctx.runId),
        })
        setLastOutcome({
          status: outcome.status === "completed" ? "completed" : outcome.status,
          step: outcome.step,
          detail:
            outcome.status === "failed"
              ? outcome.message
              : outcome.status === "blocked"
                ? outcome.reason
                : outcome.status === "awaiting-approval"
                  ? outcome.approval
                  : undefined,
          ran: outcome.status === "completed" ? [outcome.step] : [],
        })
      } finally {
        setBusy(false)
        setActiveStep(null)
      }
    },
    [busy, handlers]
  )

  const reset = useCallback(() => {
    runState.current = createCreatorRunState()
    setLastOutcome(null)
  }, [])

  return { activeStep, busy, lastOutcome, advance, step, reset }
}
