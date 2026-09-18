"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, CheckCircle2Icon } from "lucide-react"

import type { GroundingPart as GroundingPartType } from "@/lib/claude/parts-extensions"
import { ToolRowShell } from "@/components/chat/message-parts/tool-row"

export function GroundingPart({ part }: { part: GroundingPartType }) {
  const t = useTranslations("chat.grounding")
  // Unsupported claims are the warning — open by default so they read
  // without a click, same convention as failed tool rows.
  const [open, setOpen] = useState(true)
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
    // Same row language as the rest of the stream: amber warning dot +
    // unsupported-claim count; the claims list expands under the left rule.
    <ToolRowShell
      className="my-2"
      status="warning"
      open={open}
      onToggle={() => setOpen((v) => !v)}
      ariaLabel={t("unsupported", { count: unsupported.length })}
      testId="grounding-unsupported"
      lead={
        <span className="shrink-0 text-xs text-amber-700 dark:text-amber-400">
          {t("unsupported", { count: unsupported.length })}
        </span>
      }
      icon={
        <AlertTriangleIcon
          className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden
        />
      }
      target={<span className="flex-1" />}
    >
      <ul className="mb-1 list-disc space-y-1 border-l pl-5 pt-1 text-xs text-muted-foreground">
        {unsupported.map((claim) => (
          <li key={claim.id}>{claim.text}</li>
        ))}
      </ul>
    </ToolRowShell>
  )
}
