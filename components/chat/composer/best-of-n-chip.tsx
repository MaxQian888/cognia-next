"use client"

import { useTranslations } from "next-intl"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"

export function BestOfNChip({
  value,
  onChange,
  disabled,
}: {
  value: 2 | 3 | 4 | null
  onChange(value: 2 | 3 | 4 | null): void
  disabled?: boolean
}) {
  const t = useTranslations("bestOfNEntry")
  return (
    <div className="flex items-center gap-2 px-2 py-1">
      <NativeSelect
        aria-label={t("chip")}
        value={value ?? "off"}
        disabled={disabled}
        onChange={(event) =>
          onChange(event.target.value === "off" ? null : (Number(event.target.value) as 2 | 3 | 4))
        }
      >
        <NativeSelectOption value="off">{t("off")}</NativeSelectOption>
        {[2, 3, 4].map((n) => (
          <NativeSelectOption key={n} value={n}>
            {t("attempts", { count: n })}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {value && <span className="text-xs text-muted-foreground">{t("nextSend")}</span>}
    </div>
  )
}
