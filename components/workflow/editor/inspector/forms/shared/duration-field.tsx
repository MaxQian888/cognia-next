"use client"

/**
 * DurationField — a number input paired with a unit selector (ms / sec / min /
 * hour) that reads and writes a raw millisecond value. Used by `flow.wait` so
 * authors don't have to hand-convert "5 minutes" into `300000`.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const UNIT_MS = { ms: 1, sec: 1000, min: 60_000, hour: 3_600_000 } as const
type Unit = keyof typeof UNIT_MS

/** Choose the largest unit that divides the value exactly, for a tidy display. */
function pickInitialUnit(ms: number): Unit {
  if (ms > 0 && ms % UNIT_MS.hour === 0) return "hour"
  if (ms > 0 && ms % UNIT_MS.min === 0) return "min"
  if (ms > 0 && ms % UNIT_MS.sec === 0) return "sec"
  return "ms"
}

export interface DurationFieldProps {
  id: string
  /** Stored value, in milliseconds. */
  value: number
  /** Emits the new millisecond value. */
  onChange: (ms: number) => void
}

export function DurationField({ id, value, onChange }: DurationFieldProps) {
  const t = useTranslations("workflows.forms.wait.durationMs.units")
  const [unit, setUnit] = useState<Unit>(() => pickInitialUnit(value))

  const display = value / UNIT_MS[unit]

  return (
    <div className="grid grid-cols-[1fr_auto] gap-2">
      <Input
        id={id}
        type="number"
        min={0}
        value={Number.isFinite(display) ? display : 0}
        onChange={(e) => {
          const n = Number(e.target.value) || 0
          onChange(Math.max(0, Math.round(n * UNIT_MS[unit])))
        }}
      />
      <Select value={unit} onValueChange={(u) => setUnit(u as Unit)}>
        <SelectTrigger className="w-28" data-testid={`${id}-unit`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ms">{t("ms")}</SelectItem>
          <SelectItem value="sec">{t("sec")}</SelectItem>
          <SelectItem value="min">{t("min")}</SelectItem>
          <SelectItem value="hour">{t("hour")}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}
