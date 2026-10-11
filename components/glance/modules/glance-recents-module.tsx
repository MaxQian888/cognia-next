"use client"

/**
 * Recents module: the conversations last touched, one click to resume
 * (ADR-0225 §2). Resuming focuses the main window on that conversation.
 */

import { useFormatter, useTranslations } from "next-intl"
import { MessageSquareIcon } from "lucide-react"

import type { GlanceModuleSize } from "@/types/glance/layout"

import { useGlance } from "../glance-context"
import { GlanceCompactSection, GlanceRow, GlanceSection } from "../glance-primitives"

export function GlanceRecentsModule({ size }: { size: GlanceModuleSize }) {
  const t = useTranslations("glance.modules.recents")
  const format = useFormatter()
  const { snapshot, route, now } = useGlance()
  const recents = snapshot.recents
  const title = t("label")

  if (!recents) {
    return (
      <GlanceCompactSection moduleId="recents" title={title}>
        <span className="text-muted-foreground">{t("loading")}</span>
      </GlanceCompactSection>
    )
  }

  const first = recents.rows[0]
  if (size === "compact") {
    return first ? (
      <GlanceCompactSection
        moduleId="recents"
        title={title}
        label={t("resume", { title: first.title })}
        onClick={() => route({ kind: "open-session", sessionId: first.id })}
        trailing={
          <span className="shrink-0 text-[11.5px] text-muted-foreground">
            {format.relativeTime(new Date(first.updatedAt), now)}
          </span>
        }
      >
        <span className="truncate">{first.title}</span>
      </GlanceCompactSection>
    ) : (
      <GlanceCompactSection moduleId="recents" title={title}>
        <span className="text-muted-foreground">{t("empty")}</span>
      </GlanceCompactSection>
    )
  }

  return (
    <GlanceSection moduleId="recents" title={title}>
      {recents.rows.length === 0 ? (
        <GlanceRow>
          <span className="text-muted-foreground">{t("empty")}</span>
        </GlanceRow>
      ) : null}
      {recents.rows.map((row) => (
        <GlanceRow
          key={row.id}
          leading={
            <MessageSquareIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          }
          sub={format.relativeTime(new Date(row.updatedAt), now)}
          label={t("resume", { title: row.title })}
          onClick={() => route({ kind: "open-session", sessionId: row.id })}
        >
          {row.title}
        </GlanceRow>
      ))}
    </GlanceSection>
  )
}
