"use client"

/**
 * Structured payload editor for `plan` tasks. Executes an existing AgentPlan
 * (ADR-0045) via `getPlanRuntime().runPlan`. Plans persist in Dexie, so the
 * picker lists all stored plans newest-first.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import type { PlanDraft } from "./types"

export interface PlanPayloadEditorProps {
  draft: PlanDraft
  onDraftChange: (next: PlanDraft) => void
  errors?: Record<string, string>
  disabled?: boolean
  testId?: string
  /** Injectable list for tests (bypasses Dexie). */
  plansForTesting?: Array<{ id: string; title: string; status: string }>
}

export function PlanPayloadEditor({
  draft,
  onDraftChange,
  errors,
  disabled,
  testId = "plan-payload-editor",
  plansForTesting,
}: PlanPayloadEditorProps) {
  const t = useTranslations("scheduler")
  const [plans, setPlans] = useState<Array<{ id: string; title: string; status: string }> | null>(
    plansForTesting ?? null
  )

  useEffect(() => {
    if (plansForTesting) return
    let cancelled = false
    import("@/lib/db/plans")
      .then(({ listAllPlans }) => listAllPlans(200))
      .then((rows) => {
        if (cancelled) return
        setPlans(rows.map((p) => ({ id: p.id, title: p.title, status: p.status })))
      })
      .catch(() => {
        if (!cancelled) setPlans([])
      })
    return () => {
      cancelled = true
    }
  }, [plansForTesting])

  function update<K extends keyof PlanDraft>(key: K, value: PlanDraft[K]) {
    onDraftChange({ ...draft, [key]: value })
  }

  const hasPlans = (plans?.length ?? 0) > 0

  return (
    <div className="space-y-4" data-testid={testId}>
      <div className="space-y-2">
        <Label className="text-sm font-medium">
          {t("payload.plan.planId")} <span className="text-destructive">*</span>
        </Label>
        {hasPlans ? (
          <Select
            value={draft.planId || "__none__"}
            onValueChange={(v) => update("planId", v === "__none__" ? "" : v)}
            disabled={disabled}
          >
            <SelectTrigger
              className={cn("h-10", errors?.planId && "border-destructive")}
              data-testid={`${testId}-plan-select`}
            >
              <SelectValue placeholder={t("payload.plan.planIdPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">{t("payload.plan.planIdPlaceholder")}</SelectItem>
              {(plans ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.title} <span className="text-xs text-muted-foreground">({p.status})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            value={draft.planId}
            onChange={(e) => update("planId", e.target.value)}
            placeholder={t("payload.plan.planIdPlaceholder")}
            disabled={disabled}
            className={cn("h-10 font-mono text-sm", errors?.planId && "border-destructive")}
            data-testid={`${testId}-plan-input`}
          />
        )}
        {errors?.planId && (
          <p className="text-xs text-destructive">{t(`payload.errors.${errors.planId}`)}</p>
        )}
      </div>

      <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
        <div>
          <Label className="text-sm font-medium">{t("payload.plan.replanOnFailure")}</Label>
          <p className="text-[11px] text-muted-foreground">
            {t("payload.plan.replanOnFailureHelp")}
          </p>
        </div>
        <Switch
          checked={draft.replanOnFailure}
          onCheckedChange={(v) => update("replanOnFailure", v)}
          disabled={disabled}
          data-testid={`${testId}-replan-switch`}
        />
      </div>
    </div>
  )
}
