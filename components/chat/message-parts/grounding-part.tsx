"use client"

import { useTranslations } from "next-intl"
import { AlertTriangleIcon, CheckCircle2Icon } from "lucide-react"

import type { GroundingPart as GroundingPartType } from "@/lib/claude/parts-extensions"

export function GroundingPart({ part }: { part: GroundingPartType }) {
  const t = useTranslations("chat.grounding")
  const unsupported = part.claims.filter((claim) => !claim.supported)
  if (part.action === "allow" || unsupported.length === 0) {
    return (
      <div
        className="not-prose my-2 flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400"
        data-testid="grounding-supported"
        role="status"
      >
        <CheckCircle2Icon className="size-3.5" aria-hidden />
        <span>{t("supported")}</span>
      </div>
    )
  }

  return (
    <details
      className="not-prose my-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-xs"
      data-testid="grounding-unsupported"
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-amber-700 dark:text-amber-400">
        <AlertTriangleIcon className="size-3.5" aria-hidden />
        <span>{t("unsupported", { count: unsupported.length })}</span>
      </summary>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
        {unsupported.map((claim) => (
          <li key={claim.id}>{claim.text}</li>
        ))}
      </ul>
    </details>
  )
}
