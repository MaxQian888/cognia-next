"use client"

/**
 * What the reflection attributed to each edit, the verdicts on the lessons
 * the editors were given, and what the experience library did with the new
 * lesson (stored, merged, dropped, or flagged as conflicting).
 */

import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import type { HarnessReflectionRecord } from "@/types/harness/evolution"
import { useStepLabel } from "./harness-run-timeline"

const VERDICT_VARIANT = {
  helped: "success",
  hurt: "destructive",
  "no observed effect": "outline",
  confounded: "warning",
} as const

const VERDICT_KEY = {
  helped: "helped",
  hurt: "hurt",
  "no observed effect": "noEffect",
  confounded: "confounded",
} as const

export function HarnessReflectionPanel({
  reflection,
  onOpenExperience,
}: {
  reflection: HarnessReflectionRecord
  onOpenExperience?: (id: string) => void
}) {
  const t = useTranslations("harnessEvolution.reflection")
  const labelOf = useStepLabel()
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="harness-reflection">
      {reflection.edits.length ? (
        <ul className="flex flex-col gap-2">
          {reflection.edits.map((edit, i) => (
            <li
              key={`${edit.component}-${i}`}
              className="flex flex-col gap-1 rounded-md border p-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <code className="text-xs">{edit.component}</code>
                <Badge variant={VERDICT_VARIANT[edit.verdict]}>
                  {t(`verdict.${VERDICT_KEY[edit.verdict]}`)}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {edit.candidates.map(labelOf).join(", ")}
                </span>
              </div>
              <p>{edit.change}</p>
              <p className="text-xs text-muted-foreground">{edit.observed}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">{t("noEdits")}</p>
      )}
      {reflection.retrieved.length ? (
        <div className="flex flex-col gap-1">
          <h5 className="text-xs font-medium">{t("retrieved")}</h5>
          <ul className="flex flex-wrap gap-1.5">
            {reflection.retrieved.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className="text-xs underline-offset-2 hover:underline"
                  onClick={() => onOpenExperience?.(r.id)}
                >
                  <Badge variant={VERDICT_VARIANT[r.verdict]}>
                    {t("retrievedVerdict", { verdict: t(`verdict.${VERDICT_KEY[r.verdict]}`) })}
                  </Badge>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="text-xs text-muted-foreground" data-testid="harness-reflection-library">
        {reflection.droppedExperience ? (
          <p>{t("dropped", { reason: reflection.droppedExperience })}</p>
        ) : reflection.mergedInto ? (
          <p>
            {t("merged")}{" "}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => onOpenExperience?.(reflection.mergedInto as string)}
            >
              {t("openLesson")}
            </button>
          </p>
        ) : reflection.experienceId ? (
          <p>
            {t("stored")}{" "}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => onOpenExperience?.(reflection.experienceId as string)}
            >
              {t("openLesson")}
            </button>
          </p>
        ) : null}
        {reflection.conflictsWith?.length ? (
          <p className="text-warning">
            {t("conflicts", { count: reflection.conflictsWith.length })}
          </p>
        ) : null}
      </div>
    </div>
  )
}
