"use client"

// A dollar amount for a Router + Fusion setting (ADR-0188 D22): kept as the
// exact decimal string the ledger converts to integer microusd, validated on
// every keystroke and saved on blur only when it converts. `allowBlank` lets a
// per-action field be emptied to fall back to its mode's cap.

import { useState } from "react"
import { useTranslations } from "next-intl"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MoneyError, usdToMicrousd } from "@cognia/router-fusion/money/microusd"

export function isUsdAmount(value: string): boolean {
  try {
    usdToMicrousd(value.trim())
    return true
  } catch (error) {
    if (error instanceof MoneyError) return false
    throw error
  }
}

export interface RouterFusionUsdFieldProps {
  id: string
  label: string
  description: string
  /** The saved amount; `""` for none when `allowBlank`. */
  value: string
  placeholder?: string
  /** An emptied field saves `""`, which the caller reads as "no amount of its own". */
  allowBlank?: boolean
  onCommit: (value: string) => void
}

export function RouterFusionUsdField({
  id,
  label,
  description,
  value,
  placeholder,
  allowBlank = false,
  onCommit,
}: RouterFusionUsdFieldProps) {
  const t = useTranslations("routerFusion.settings.budget")
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? value
  const acceptable = (text: string) => (allowBlank && text.trim() === "") || isUsdAmount(text)
  const invalid = draft !== null && !acceptable(draft)
  return (
    <div className="space-y-1.5">
      <Label className="text-xs" htmlFor={id}>
        {label}
      </Label>
      <Input
        id={id}
        inputMode="decimal"
        value={shown}
        placeholder={placeholder}
        aria-invalid={invalid}
        aria-describedby={`${id}-desc`}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft === null) return
          if (acceptable(draft)) {
            const next = draft.trim()
            setDraft(null)
            if (next !== value) onCommit(next)
          }
        }}
        className="h-8 w-40 text-xs"
      />
      <p
        id={`${id}-desc`}
        className={invalid ? "text-[11px] text-destructive" : "text-[11px] text-muted-foreground"}
      >
        {invalid ? t("invalidAmount") : description}
      </p>
    </div>
  )
}
