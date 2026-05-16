"use client"

import { useTranslations } from "next-intl"
import { AlertTriangleIcon, CheckCircle2Icon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { SkillValidationError } from "@/lib/claude/types"

interface Props {
  errors: SkillValidationError[]
}

// Sentinel used to bucket validation errors that don't name a specific field.
// Resolved to a localized label at render time.
const UNFIELDED_KEY = "__unfielded__"

export function SkillValidationSection({ errors }: Props) {
  const t = useTranslations("skills.validation")
  if (errors.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed p-4 text-xs text-muted-foreground">
        <CheckCircle2Icon className="size-4 text-emerald-500" />
        {t("empty")}
      </div>
    )
  }
  const grouped = groupByField(errors)
  return (
    <div className="space-y-3">
      {grouped.map(({ field, items }) => {
        const label = field === UNFIELDED_KEY ? t("unfielded") : field
        const isUnfielded = field === UNFIELDED_KEY
        return (
          <div key={field} role="group" className="rounded-md border p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium">
              <AlertTriangleIcon className="size-3.5 text-destructive" />
              <span className={isUnfielded ? undefined : "font-mono"}>{label}</span>
              <Badge variant="destructive" className="ml-auto h-4 px-1.5 text-[10px]">
                {items.length}
              </Badge>
            </div>
            <ul className="space-y-1.5 text-xs">
              {items.map((e, i) => (
                <li key={`${e.code}-${i}`} className="flex items-start gap-2">
                  <code className="rounded bg-muted px-1 py-0.5 text-[10px]">{e.code}</code>
                  <span>{e.message}</span>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

function groupByField(errors: SkillValidationError[]) {
  const map = new Map<string, SkillValidationError[]>()
  for (const e of errors) {
    const key = e.field ?? UNFIELDED_KEY
    const arr = map.get(key) ?? []
    arr.push(e)
    map.set(key, arr)
  }
  return [...map.entries()].map(([field, items]) => ({ field, items }))
}
