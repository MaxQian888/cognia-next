"use client"

/**
 * Stage 3 — the review pass.
 *
 * Master/detail when the Sheet is wide enough, one-at-a-time when it is not.
 * The threshold is on the *container*, not the viewport, because the Sheet's
 * width is `clamp(420px, 64vw, 960px)` — a wide window with a narrow Sheet is a
 * real configuration.
 *
 * Blockers are listed rather than counted. "3 problems" makes the user hunt;
 * naming each one, with the step number, is the difference between a checklist
 * and a puzzle.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { AlertCircle, Plus } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { cn } from "@/lib/utils"
import {
  insertManualStep,
  removeManualStep,
  reorderSteps,
  reviewBlockers,
  restoreStep,
  setStepEdit,
  excludeStep,
  includedSteps,
} from "@/lib/skills/recording/step-model"
import { confirmVariable } from "@/lib/skills/recording/input-variables"
import { loadAssetBytes } from "@/lib/skills/recording/controller"
import { useRecorderStore } from "@/stores/skills/recorder-store"
import {
  useRecorderSelectedStep,
  useRecorderSteps,
  useRecorderVariables,
} from "@/hooks/skills/use-skill-recorder"
import { ReviewTimeline } from "./review-timeline"
import { ReviewStepDetail } from "./review-step-detail"
import { ReviewVariables } from "./review-variables"

/** Below this the split is unusable and the panes swap instead. */
const SPLIT_MIN_PX = 640

export function StageReview({ containerWidth }: { containerWidth: number }) {
  const t = useTranslations("skills.recorder")
  const steps = useRecorderSteps()
  const variables = useRecorderVariables()
  const selected = useRecorderSelectedStep()
  const edits = useRecorderStore((state) => state.edits)
  const setEdits = useRecorderStore((state) => state.setEdits)
  const dispatch = useRecorderStore((state) => state.dispatch)
  const setUi = useRecorderStore((state) => state.setUi)
  const detailView = useRecorderStore((state) => state.detailView)
  const splitPercent = useRecorderStore((state) => state.splitPercent)
  const selectedSeq = useRecorderStore((state) => state.selectedStepSeq)
  const ignoredCount = useRecorderStore((state) => state.ignoredCount)

  const [manualDraft, setManualDraft] = useState("")
  const canSplit = containerWidth >= SPLIT_MIN_PX
  const blockers = reviewBlockers(steps, variables)

  const applyEdits = (next: typeof edits) => {
    setEdits(next)
    dispatch({ type: "EDIT_STEPS", edits: next })
  }

  const timeline = (
    <ReviewTimeline
      steps={steps}
      selectedSeq={selectedSeq}
      onSelect={(seq) => setUi({ selectedStepSeq: seq, detailView: "detail" })}
      onToggleExclude={(seq, excluded) =>
        applyEdits(excluded ? excludeStep(edits, seq) : restoreStep(edits, seq))
      }
    />
  )

  const detail = (
    <ReviewStepDetail
      step={selected}
      loadScreenshot={loadAssetBytes}
      onIntentChange={(seq, intent) => applyEdits(setStepEdit(edits, seq, { intent }))}
      onVerifyChange={(seq, verify) => applyEdits(setStepEdit(edits, seq, { verify }))}
      onScreenshotToggle={(seq, screenshotSelected) =>
        applyEdits(setStepEdit(edits, seq, { screenshotSelected }))
      }
      onMove={(seq, delta) => applyEdits(reorderSteps(steps, edits, seq, delta))}
      onRemoveManual={(seq) => {
        applyEdits(removeManualStep(edits, seq))
        setUi({ selectedStepSeq: null })
      }}
    />
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t("review.stepCount", {
            included: includedSteps(steps).length,
            total: steps.length,
          })}
          {ignoredCount > 0 ? ` · ${t("recording.ignored", { count: ignoredCount })}` : null}
        </p>
        {!canSplit ? (
          <ToggleGroup
            type="single"
            size="sm"
            value={detailView}
            onValueChange={(value) =>
              value ? setUi({ detailView: value as "timeline" | "detail" }) : undefined
            }
          >
            <ToggleGroupItem value="timeline">{t("review.viewTimeline")}</ToggleGroupItem>
            <ToggleGroupItem value="detail">{t("review.viewDetail")}</ToggleGroupItem>
          </ToggleGroup>
        ) : null}
      </div>

      {steps.length === 0 ? (
        <Empty className="rounded-none border-y py-6">
          <EmptyHeader>
            <EmptyTitle className="text-sm">{t("review.emptyTitle")}</EmptyTitle>
            <EmptyDescription className="text-xs">{t("review.emptyHint")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : canSplit ? (
        <div className="flex min-h-0 flex-1 gap-2">
          <div className="min-w-0 overflow-hidden" style={{ flexBasis: `${splitPercent}%` }}>
            {timeline}
          </div>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("review.splitAria")}
            aria-valuenow={splitPercent}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") setUi({ splitPercent: Math.max(25, splitPercent - 4) })
              if (event.key === "ArrowRight")
                setUi({ splitPercent: Math.min(70, splitPercent + 4) })
            }}
            className="w-1 shrink-0 cursor-col-resize rounded bg-border outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="min-w-0 flex-1 overflow-y-auto">{detail}</div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {detailView === "timeline" ? timeline : detail}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Input
          value={manualDraft}
          placeholder={t("review.manualPlaceholder")}
          onChange={(event) => setManualDraft(event.target.value)}
          aria-label={t("review.manualTitle")}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={manualDraft.trim().length === 0}
          onClick={() => {
            const anchor = selectedSeq ?? steps[steps.length - 1]?.seq ?? 0
            applyEdits(insertManualStep(edits, anchor, manualDraft.trim()))
            setManualDraft("")
          }}
        >
          <Plus className="size-4" aria-hidden />
          {t("review.manualSave")}
        </Button>
      </div>

      <ReviewVariables
        variables={variables}
        onConfirm={(seq, patch) =>
          dispatch({ type: "SET_VARIABLES", variables: confirmVariable(variables, seq, patch) })
        }
      />

      {blockers.length > 0 ? (
        <Alert>
          <AlertCircle className="size-4" aria-hidden />
          <AlertDescription>
            <ul className={cn("list-disc space-y-1 pl-4 text-xs")}>
              {blockers.map((blocker, index) => (
                <li key={`${blocker.code}-${index}`}>
                  {t(`review.blockers.${blocker.code}`, blocker as never)}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}
