"use client"

import { useTranslations } from "next-intl"
import { XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

export interface BestOfNChoiceProps {
  value: 2 | 3 | 4 | null
  onChange(value: 2 | 3 | 4 | null): void
  disabled?: boolean
}

export function BestOfNSelect({ value, onChange, disabled }: BestOfNChoiceProps) {
  const t = useTranslations("bestOfNEntry")
  return (
    <Select
      value={value === null ? "off" : String(value)}
      disabled={disabled}
      onValueChange={(next) => onChange(next === "off" ? null : (Number(next) as 2 | 3 | 4))}
    >
      <SelectTrigger size="sm" className="text-xs" aria-label={t("chip")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="end">
        <SelectGroup>
          <SelectItem value="off">{t("off")}</SelectItem>
          {[2, 3, 4].map((n) => (
            <SelectItem key={n} value={String(n)}>
              {t("attempts", { count: n })}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

export function BestOfNChip({
  value,
  onChange,
  disabled,
  compact = false,
}: BestOfNChoiceProps & { compact?: boolean }) {
  const t = useTranslations("bestOfNEntry")
  if (!value) return null
  return (
    <div
      className="flex h-7 min-w-0 shrink items-center gap-1 rounded-md bg-muted/60 ps-2 text-[11px] text-foreground"
      title={`${t("attempts", { count: value })} · ${t("nextSend")}`}
    >
      <span className="min-w-0 truncate">
        {t(compact ? "compactAttempts" : "attempts", { count: value })}
      </span>
      {compact && <span className="sr-only">{t("attempts", { count: value })}</span>}
      <span className={cn("whitespace-nowrap text-muted-foreground", compact && "sr-only")}>
        · {t("nextSend")}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="touch-hit size-6 shrink-0 text-muted-foreground"
        aria-label={t("clear")}
        disabled={disabled}
        onClick={() => onChange(null)}
      >
        <XIcon className="size-3" />
      </Button>
    </div>
  )
}
