"use client"

/**
 * Dataset gate thresholds editor — five optional numeric fields persisted to
 * `EvalDataset.gate` and consumed by `evaluateGate` (run badges, the
 * `eval.gate` workflow node, CI). Empty field = threshold unset; all empty =
 * gate removed. The per-scorer map form of `minScorerPassRate` stays an
 * engine-only capability (UI exposes the single-number floor).
 *
 * `maxUngradedRatio` is the guard against a perfect pass rate measured over
 * almost nothing: without it, a run where 95% of cases had no applicable
 * scorer and the remaining 5% passed still clears `minPassAt1`.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { updateDataset } from "@/lib/db/eval-datasets"
import type { GateThresholds } from "@/types/eval/gate"

const FIELDS = [
  { key: "minPassAt1", min: 0, max: 1 },
  { key: "minPassHatK", min: 0, max: 1 },
  { key: "minScorerPassRate", min: 0, max: 1 },
  { key: "maxUngradedRatio", min: 0, max: 1 },
  { key: "maxTotalCostUsd", min: 0 },
] as const

type FieldKey = (typeof FIELDS)[number]["key"]

function initialDraft(gate?: GateThresholds): Record<FieldKey, string> {
  return {
    minPassAt1: gate?.minPassAt1 !== undefined ? String(gate.minPassAt1) : "",
    minPassHatK: gate?.minPassHatK !== undefined ? String(gate.minPassHatK) : "",
    minScorerPassRate:
      typeof gate?.minScorerPassRate === "number" ? String(gate.minScorerPassRate) : "",
    maxUngradedRatio: gate?.maxUngradedRatio !== undefined ? String(gate.maxUngradedRatio) : "",
    maxTotalCostUsd: gate?.maxTotalCostUsd !== undefined ? String(gate.maxTotalCostUsd) : "",
  }
}

export interface GateConfigSectionProps {
  datasetId: string
  gate?: GateThresholds
}

export function GateConfigSection({ datasetId, gate }: GateConfigSectionProps) {
  const t = useTranslations("eval.gate")
  const [draft, setDraft] = useState<Record<FieldKey, string>>(() => initialDraft(gate))
  const [saved, setSaved] = useState(false)

  const handleSave = async () => {
    const next: GateThresholds = {}
    for (const f of FIELDS) {
      const raw = draft[f.key].trim()
      if (!raw) continue
      const num = Number(raw)
      if (!Number.isFinite(num)) continue
      next[f.key] = num
    }
    await updateDataset(datasetId, {
      gate: Object.keys(next).length > 0 ? next : undefined,
    })
    setSaved(true)
  }

  return (
    <div className="flex flex-col gap-3" data-testid="gate-config-section">
      <p className="text-muted-foreground text-xs">{t("hint")}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <label key={f.key} className="flex flex-col gap-1 text-sm">
            <span>{t(`fields.${f.key}`)}</span>
            <Input
              type="number"
              step="0.01"
              min={f.min}
              {...("max" in f ? { max: f.max } : {})}
              aria-label={t(`fields.${f.key}`)}
              value={draft[f.key]}
              onChange={(e) => {
                setSaved(false)
                setDraft((cur) => ({ ...cur, [f.key]: e.target.value }))
              }}
            />
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void handleSave()}>
          {t("save")}
        </Button>
        {saved && (
          <span className="text-xs text-emerald-600 dark:text-emerald-400" role="status">
            {t("savedNotice")}
          </span>
        )}
      </div>
    </div>
  )
}
