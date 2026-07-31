"use client"

/**
 * PlanHtmlView — host for the enhanced plan mode's interactive HTML editor.
 *
 * Renders the document produced by `lib/agent/plan/plan-html.ts:buildPlanHtml`
 * inside a sandboxed iframe (`allow-scripts` only — no same-origin access) and
 * bridges its postMessage protocol back into the plan approval flow:
 *
 *   - `cognia-plan-ready`  → hide the boot shimmer
 *   - `cognia-plan-resize` → auto-size the frame to its content
 *   - `cognia-plan-save`   → translate into a {@link PlanEditPatch} for the
 *     host (`PlanApprovalCard.onEdit` → `updatePlanDraft`)
 *
 * Patch translation preserves plan fidelity: a markdown-captured plan whose
 * steps were NOT touched keeps its original rich `planText` (title-only edit);
 * once steps are adjusted interactively, the edited step list becomes the
 * source of truth and `planText` is regenerated as a bullet list so the card's
 * markdown rendering stays consistent with what executes.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useTheme } from "next-themes"
import { cn } from "@/lib/utils"
import {
  buildPlanHtml,
  resolvePlanHtmlStyle,
  PLAN_HTML_MSG,
  type PlanHtmlLabels,
  type PlanHtmlSavePayload,
  type PlanHtmlStyle,
} from "@/lib/agent/plan/plan-html"
import { Skeleton } from "@/components/ui/skeleton"
import type { AgentPlan } from "@/types/agent/plan"
import type { PlanEditPatch } from "./plan-approval-card"

const MIN_HEIGHT = 140
const MAX_HEIGHT = 560

export interface PlanHtmlViewProps {
  plan: AgentPlan
  /** Persist an interactive adjustment (same channel as the classic editor). */
  onSave: (patch: PlanEditPatch) => void
  /** Built-in visual preset (`planSettings.interactiveHtmlStyle`). */
  styleVariant?: PlanHtmlStyle
  /** Blocks interaction (e.g. while a runtime mutation is in flight). */
  disabled?: boolean
  className?: string
}

export function PlanHtmlView({
  plan,
  onSave,
  styleVariant,
  disabled,
  className,
}: PlanHtmlViewProps) {
  const t = useTranslations("plan")
  const { resolvedTheme } = useTheme()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(MIN_HEIGHT)
  const [ready, setReady] = useState(false)

  const planMeta = plan.metadata as { planText?: unknown } | undefined
  const originalPlanText = typeof planMeta?.planText === "string" ? planMeta.planText.trim() : ""

  const srcDoc = useMemo(() => {
    const labels: PlanHtmlLabels = {
      titleLabel: t("approval.interactive.titleLabel"),
      stepsLabel: t("approval.interactive.stepsLabel"),
      addStep: t("approval.interactive.addStep"),
      deleteStep: t("approval.interactive.deleteStep"),
      moveUp: t("approval.interactive.moveUp"),
      moveDown: t("approval.interactive.moveDown"),
      dragHint: t("approval.interactive.dragHint"),
      save: t("approval.interactive.save"),
      reset: t("approval.interactive.reset"),
      empty: t("approval.interactive.empty"),
      originalPlan: t("approval.interactive.originalPlan"),
      stepPlaceholder: t("approval.interactive.stepPlaceholder"),
    }
    const steps = [...plan.steps]
      .sort((a, b) => a.order - b.order)
      .map((s) => ({ id: s.id, title: s.title, status: s.status }))
    return buildPlanHtml({
      title: plan.title,
      steps,
      ...(originalPlanText ? { planText: originalPlanText } : {}),
      labels,
      theme: resolvedTheme === "dark" ? "dark" : "light",
      style: resolvePlanHtmlStyle(styleVariant),
    })
  }, [plan, originalPlanText, resolvedTheme, styleVariant, t])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Only trust our own frame — the document posts with targetOrigin "*"
      // (it is sandboxed without same-origin, so it has an opaque origin).
      if (event.source !== iframeRef.current?.contentWindow) return
      const data = event.data as { type?: unknown; height?: unknown } | null
      if (!data || typeof data.type !== "string") return

      if (data.type === PLAN_HTML_MSG.ready) {
        setReady(true)
        return
      }
      if (data.type === PLAN_HTML_MSG.resize) {
        if (typeof data.height === "number" && Number.isFinite(data.height) && data.height > 0) {
          setHeight(Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, data.height))))
        }
        return
      }
      if (data.type === PLAN_HTML_MSG.save) {
        if (disabled) return
        const payload = data as unknown as PlanHtmlSavePayload
        if (!Array.isArray(payload.stepTitles) || typeof payload.title !== "string") return
        const stepTitles = payload.stepTitles
          .filter((s): s is string => typeof s === "string")
          .map((s) => s.trim())
          .filter(Boolean)
        if (stepTitles.length === 0) return
        const title = payload.title.trim().slice(0, 120) || plan.title
        if (originalPlanText && payload.stepsChanged !== true) {
          // Title-only edit on a markdown plan — keep the rich body intact.
          onSave({ title, planText: originalPlanText })
        } else if (originalPlanText) {
          // Steps were adjusted: the edited list is now the source of truth;
          // regenerate the body so display and execution can't diverge.
          onSave({ title, planText: stepTitles.map((s) => `- ${s}`).join("\n") })
        } else {
          onSave({ title, stepTitles })
        }
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [disabled, onSave, originalPlanText, plan.title])

  return (
    <div className={cn("relative min-h-0 overflow-hidden rounded-md border", className)}>
      {!ready && (
        <Skeleton className="absolute inset-0 bg-muted/40" data-testid="plan-html-loading" />
      )}
      {disabled && (
        <div
          className="absolute inset-0 z-10 cursor-not-allowed bg-background/40"
          data-testid="plan-html-disabled-overlay"
          aria-hidden="true"
        />
      )}
      <iframe
        ref={iframeRef}
        srcDoc={srcDoc}
        sandbox="allow-scripts"
        title={t("approval.interactive.frameTitle")}
        className="block w-full border-0"
        style={{ height: `${height}px` }}
        data-testid="plan-html-frame"
      />
    </div>
  )
}
