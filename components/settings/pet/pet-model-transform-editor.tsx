// Transform tab of the per-model Live2D config dialog: scale + X/Y offset as
// slider/number pairs, every write funneled through `normalizeTransform` so
// the draft can never hold an out-of-range value. Presentational — the dialog
// owns the draft state and persistence.

"use client"

import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import {
  normalizeTransform,
  TRANSFORM_OFFSET_MAX,
  TRANSFORM_OFFSET_MIN,
  TRANSFORM_SCALE_MAX,
  TRANSFORM_SCALE_MIN,
} from "@/lib/pet/live2d/transform"
import { DEFAULT_LIVE2D_TRANSFORM, type Live2dTransform } from "@/types/pet"

export interface PetModelTransformEditorProps {
  value: Live2dTransform
  onChange: (next: Live2dTransform) => void
}

interface FieldSpec {
  key: keyof Live2dTransform
  min: number
  max: number
  step: number
}

const FIELDS: FieldSpec[] = [
  { key: "scale", min: TRANSFORM_SCALE_MIN, max: TRANSFORM_SCALE_MAX, step: 0.05 },
  { key: "offsetX", min: TRANSFORM_OFFSET_MIN, max: TRANSFORM_OFFSET_MAX, step: 0.01 },
  { key: "offsetY", min: TRANSFORM_OFFSET_MIN, max: TRANSFORM_OFFSET_MAX, step: 0.01 },
]

export function PetModelTransformEditor({ value, onChange }: PetModelTransformEditorProps) {
  const t = useTranslations("settings.pet.live2d.config")

  const patch = (key: keyof Live2dTransform, raw: number) => {
    onChange(normalizeTransform({ ...value, [key]: raw }))
  }

  return (
    <FieldGroup>
      {FIELDS.map(({ key, min, max, step }) => (
        <Field key={key}>
          <div className="flex items-center justify-between gap-4">
            <FieldLabel htmlFor={`pet-transform-${key}`}>{t(key)}</FieldLabel>
            <Input
              id={`pet-transform-${key}`}
              type="number"
              className="w-24"
              min={min}
              max={max}
              step={step}
              value={value[key]}
              onChange={(e) => {
                // A number input reports "" for in-progress/invalid text —
                // Number("") is 0, so bail before coercing.
                const raw = e.target.value
                if (raw.trim() === "") return
                const n = Number(raw)
                if (Number.isFinite(n)) patch(key, n)
              }}
            />
          </div>
          <Slider
            aria-label={t(key)}
            min={min}
            max={max}
            step={step}
            value={[value[key]]}
            onValueChange={([v]) => patch(key, v)}
          />
        </Field>
      ))}
      <Button variant="outline" size="sm" onClick={() => onChange({ ...DEFAULT_LIVE2D_TRANSFORM })}>
        {t("resetTransform")}
      </Button>
    </FieldGroup>
  )
}
