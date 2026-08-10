"use client"

/**
 * Editor for a {@link GradingSpec} — how a case's golden answer is compared
 * against what the agent said.
 *
 * Shared by the import wizard (stamped onto every imported case) and the case
 * editor (per-case override), because the alternative is two divergent copies
 * of the same five modes and their options.
 *
 * The live extraction preview is the point of the whole component: `numeric`
 * with a `####` pattern and `choice` against a letter alphabet are impossible
 * to get right blind, and a wrong rule does not fail loudly — it just grades
 * nothing. Showing what the rule pulls out of a real sample row turns that into
 * something the user can see before importing a thousand cases.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { extractChoice, extractNumber } from "@/lib/ai/eval/scorers/match"
import { GRADING_MODES, GSM8K_ANSWER_PATTERN } from "@/types/eval/grading"
import type { GradingMode, GradingSpec } from "@/types/eval/grading"

export interface GradingEditorProps {
  value: GradingSpec
  onChange: (next: GradingSpec) => void
  /** A real golden answer from the source, to preview extraction against. */
  sampleExpected?: string
}

/** What `spec` would pull out of `text`, or `null` when it extracts nothing. */
export function previewExtraction(spec: GradingSpec, text: string): string | null {
  if (!text) return null
  if (spec.mode === "numeric") {
    const n = extractNumber(text, spec.pattern)
    return n === null ? null : String(n)
  }
  if (spec.mode === "choice") return extractChoice(text, spec.alphabet)
  return null
}

export function GradingEditor({ value, onChange, sampleExpected }: GradingEditorProps) {
  const t = useTranslations("eval.grading")

  const extracted = useMemo(
    () => (sampleExpected ? previewExtraction(value, sampleExpected) : null),
    [value, sampleExpected]
  )
  const showsExtraction = value.mode === "numeric" || value.mode === "choice"

  const patch = (next: Partial<GradingSpec>) => onChange({ ...value, ...next })
  const normalize = value.normalize ?? {}
  const patchNormalize = (next: Partial<NonNullable<GradingSpec["normalize"]>>) =>
    patch({ normalize: { ...normalize, ...next } })

  return (
    <div className="flex flex-col gap-2 rounded-md border p-2" data-testid="grading-editor">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{t("mode")}</span>
        <NativeSelect
          aria-label={t("mode")}
          size="sm"
          wrapperClassName="w-full"
          value={value.mode}
          onChange={(e) => patch({ mode: e.target.value as GradingMode })}
        >
          {GRADING_MODES.map((m) => (
            <NativeSelectOption key={m} value={m}>
              {t(`modes.${m}` as never)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      <p className="text-muted-foreground text-xs">{t(`hints.${value.mode}` as never)}</p>

      {value.mode === "numeric" && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("pattern")}</span>
            <Input
              aria-label={t("pattern")}
              placeholder={GSM8K_ANSWER_PATTERN}
              value={value.pattern ?? ""}
              onChange={(e) => patch({ pattern: e.target.value || undefined })}
              className="font-mono text-xs"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("tolerance")}</span>
            <Input
              type="number"
              min={0}
              step="0.001"
              aria-label={t("tolerance")}
              value={value.tolerance ?? 0}
              onChange={(e) => patch({ tolerance: Number(e.target.value) || 0 })}
            />
          </label>
        </div>
      )}

      {value.mode === "regex" && (
        <label className="flex flex-col gap-1 text-sm">
          <span>{t("pattern")}</span>
          <Input
            aria-label={t("pattern")}
            value={value.pattern ?? ""}
            onChange={(e) => patch({ pattern: e.target.value || undefined })}
            className="font-mono text-xs"
          />
        </label>
      )}

      {value.mode === "choice" && (
        <label className="flex flex-col gap-1 text-sm">
          <span>{t("alphabet")}</span>
          <Input
            aria-label={t("alphabet")}
            // i18n-exempt: option letters are literal data the user types, not UI copy
            placeholder="ABCD"
            value={value.alphabet ?? ""}
            onChange={(e) => patch({ alphabet: e.target.value.toUpperCase() || undefined })}
            className="font-mono text-xs"
          />
        </label>
      )}

      {(value.mode === "exact" || value.mode === "contains-any") && (
        <div className="flex flex-wrap gap-3 text-xs">
          <label className="flex items-center gap-1.5">
            <Checkbox
              checked={normalize.caseInsensitive !== false}
              onCheckedChange={(checked) => patchNormalize({ caseInsensitive: checked === true })}
            />
            {t("normalize.caseInsensitive")}
          </label>
          <label className="flex items-center gap-1.5">
            <Checkbox
              checked={normalize.stripPunctuation === true}
              onCheckedChange={(checked) => patchNormalize({ stripPunctuation: checked === true })}
            />
            {t("normalize.stripPunctuation")}
          </label>
          <label className="flex items-center gap-1.5">
            <Checkbox
              checked={normalize.stripArticles === true}
              onCheckedChange={(checked) => patchNormalize({ stripArticles: checked === true })}
            />
            {t("normalize.stripArticles")}
          </label>
        </div>
      )}

      {showsExtraction && sampleExpected && (
        <p
          className={extracted === null ? "text-destructive text-xs" : "text-xs"}
          data-testid="grading-extraction"
          role="status"
        >
          {extracted === null
            ? t("extractNothing", { sample: sampleExpected.slice(0, 60) })
            : t("extracted", { value: extracted })}
        </p>
      )}
    </div>
  )
}
