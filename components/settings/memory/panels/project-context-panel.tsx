"use client"

/**
 * Settings, Memory, Project context.
 *
 * The two switches that decide whether Cognia learns from this workspace's own
 * chat history, and whether it tells the model what it learned. They ship with
 * DIFFERENT defaults on purpose, mining on and injection off, and the panel
 * says so rather than leaving a user to infer it from two toggle states.
 * Learning is reversible and reviewable in `/memory`, while telling the model
 * changes every reply and is the part a user opts into.
 *
 * Read plus configure only. The miner, the re-check sweep and the backfill are
 * the write half. This panel renders the state they persist and never drives
 * them. Everything numeric here is what the runtime actually reads, since
 * `applyProjectContinuityContext` takes `projectRecallTokenBudget` and
 * `projectRecallTopK` verbatim, so the ceiling shown is the real one.
 */

import { useTranslations } from "next-intl"

import type { MemoryConfig } from "@/types/memory/memory"
import type { MemoryInsights } from "@/hooks/memory/use-memory-insights"
import { maxCombinedRecallTokens } from "@cognia/memory/runtime/recall-budget"
import { ClampedNumberInput } from "@/components/settings/common/clamped-number-input"
import { Label } from "@/components/ui/label"
import { GatedGroup, MemoryToggleRow } from "../memory-controls"

export interface ProjectContextPanelProps {
  config: MemoryConfig
  update: (patch: Partial<MemoryConfig>) => void
  insights: MemoryInsights
}

/** Job kinds this panel is the home for. */
const PROJECT_JOB_KINDS = ["project-mining", "project-claim-revalidate"] as const

export function ProjectContextPanel({ config, update, insights }: ProjectContextPanelProps) {
  const t = useTranslations("settings.memory.projectContext")

  // A temporary chat leaves no trace by definition, so neither half can run.
  // Naming which upstream switch is responsible is the difference between
  // "these are off" and "these are off because of that".
  const gated = !config.enabled || config.temporary
  const gateReason = !config.enabled ? t("gate.memoryOff") : t("gate.temporary")

  const jobs = insights.jobs.filter((job) =>
    (PROJECT_JOB_KINDS as readonly string[]).includes(job.kind)
  )
  const pending = jobs.reduce((sum, job) => sum + job.queued + job.running + job.retrying, 0)
  const failed = jobs.reduce((sum, job) => sum + job.failed, 0)

  return (
    <div className="space-y-4" data-testid="memory-project-context-panel">
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("intro")}</p>

      <GatedGroup gated={gated} reason={gated ? gateReason : undefined} className="space-y-4">
        <MemoryToggleRow
          id="mem-mine-project"
          label={t("mine.label")}
          description={t("mine.description")}
          checked={config.mineProjectContext}
          onCheckedChange={(mineProjectContext) => update({ mineProjectContext })}
        />

        <MemoryToggleRow
          id="mem-project-continuity"
          label={t("inject.label")}
          description={t("inject.description")}
          checked={config.enableProjectContinuity}
          onCheckedChange={(enableProjectContinuity) => update({ enableProjectContinuity })}
        />

        {/*
          Nested under injection, not beside it. A token budget for a section
          that is never rendered is a control with no effect, which is this
          repo's recurring "setting that lied" shape.
        */}
        <GatedGroup
          gated={!config.enableProjectContinuity}
          reason={!config.enableProjectContinuity ? t("gate.injectionOff") : undefined}
          className="grid gap-4 @md/memory-pane:grid-cols-2"
        >
          <div className="space-y-1.5">
            <Label htmlFor="mem-project-budget">{t("budget.label")}</Label>
            <ClampedNumberInput
              id="mem-project-budget"
              aria-label={t("budget.label")}
              value={config.projectRecallTokenBudget}
              min={0}
              max={900}
              integer
              onCommit={(projectRecallTokenBudget) => update({ projectRecallTokenBudget })}
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("budget.description", {
                // The honest ceiling. The project section can only borrow what
                // personal recall did not spend, so the two budgets added
                // together ARE the bound. See `maxCombinedRecallTokens`.
                max: maxCombinedRecallTokens(
                  config.recallTokenBudget,
                  config.projectRecallTokenBudget
                ),
              })}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mem-project-topk">{t("topK.label")}</Label>
            <ClampedNumberInput
              id="mem-project-topk"
              aria-label={t("topK.label")}
              value={config.projectRecallTopK}
              min={1}
              max={12}
              integer
              onCommit={(projectRecallTopK) => update({ projectRecallTopK })}
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("topK.description")}
            </p>
          </div>
        </GatedGroup>
      </GatedGroup>

      {/*
        Queue state, read straight off the shared job summary. Rendered even at
        zero, because "nothing is queued" is the answer to "is it working?" and
        a section that appears only when busy cannot answer it.
      */}
      <div className="rounded-md border p-3" data-testid="memory-project-jobs">
        <p className="text-xs font-medium">{t("jobs.title")}</p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {t("jobs.pending", { count: pending })}
          {failed > 0 ? ` · ${t("jobs.failed", { count: failed })}` : ""}
        </p>
      </div>
    </div>
  )
}
