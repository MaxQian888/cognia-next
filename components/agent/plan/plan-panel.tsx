"use client"

/**
 * Plan panel — the session-surface dock entry for the plan subsystem
 * (ADR-0045). Lists every `AgentPlan` of the session newest-first (the GUI
 * counterpart of the CLI's `/plan list`), renders the selected plan through
 * `PlanDocument`, and wires inline edits of an awaiting-approval plan to the
 * same `applyPlanEditPatch` path the approval dock uses.
 *
 * Terminal plans render read-only with their `agentPlanEvents` audit trail —
 * the counterpart of `/plan show`; a plan's execution status lives here and in
 * `PlanTrackerPanel`, never in the pre-approval editor.
 */

import { useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { listPlanEvents, listPlansBySession } from "@/lib/db/plans"
import { applyPlanEditPatch } from "@/lib/agent/plan/draft-edit"
import { PlanDocument } from "./plan-document"
import type { PlanEditPatch } from "@/types/agent/plan"

export function PlanPanel({ sessionId }: { sessionId: string }) {
  const t = useTranslations("plan")
  const plans = useLiveQuery(() => listPlansBySession(sessionId), [sessionId])
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Default selection: the open plan if one exists, else the newest record.
  const plan = useMemo(() => {
    if (!plans?.length) return null
    const selected = selectedId ? plans.find((p) => p.id === selectedId) : undefined
    if (selected) return selected
    return plans.find((p) => p.status === "awaiting_approval" || p.status === "draft") ?? plans[0]
  }, [plans, selectedId])

  const events = useLiveQuery(
    () => (plan ? listPlanEvents(plan.id, 50) : Promise.resolve([])),
    [plan?.id]
  )

  if (!plans) return null // live query still resolving
  if (!plan) {
    return (
      <p className="p-3 text-xs italic text-muted-foreground" data-testid="plan-panel-empty">
        {t("document.noPlans")}
      </p>
    )
  }

  const editable = plan.status === "awaiting_approval"
  const onEdit = editable ? (patch: PlanEditPatch) => applyPlanEditPatch(plan, patch) : undefined

  return (
    <div className="flex h-full min-h-0 flex-col gap-1 p-2" data-testid="plan-panel">
      <div className="flex items-center gap-2">
        {plans.length > 1 ? (
          <NativeSelect
            value={plan.id}
            onChange={(e) => setSelectedId(e.target.value)}
            className="h-7 min-w-0 flex-1 text-xs"
            aria-label={t("document.history")}
            data-testid="plan-panel-history"
          >
            {plans.map((p) => (
              <NativeSelectOption key={p.id} value={p.id}>
                {p.status === "awaiting_approval" || p.status === "draft"
                  ? `${p.title} · ${t("document.currentPlan")}`
                  : p.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{plan.title}</span>
        )}
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          {t(`status.${plan.status}`)}
        </Badge>
      </div>
      <PlanDocument plan={plan} editable={editable} onEdit={onEdit} showTitle events={events} />
    </div>
  )
}
