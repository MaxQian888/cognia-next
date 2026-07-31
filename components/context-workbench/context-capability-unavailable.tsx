"use client"

import { useTranslations } from "next-intl"

export function ContextCapabilityUnavailable({
  capability,
}: {
  capability: "comments" | "preview" | "workspace"
}) {
  const t = useTranslations("contextWorkbench.unavailable")
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="text-sm font-medium">{t(`${capability}.title`)}</p>
      <p className="text-xs text-muted-foreground">{t(`${capability}.description`)}</p>
    </div>
  )
}
