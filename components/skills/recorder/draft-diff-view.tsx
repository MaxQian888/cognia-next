"use client"

/**
 * Reconciling a regenerated draft with one the user edited.
 *
 * Section-by-section rather than line-by-line. Sections are what the skill
 * format is made of and what a user thinks in ("the Verify block is wrong"); a
 * line-level merge of two independently generated prose blocks produces text
 * neither model wrote.
 *
 * Nothing here overwrites. The candidate sits beside the current draft until the
 * user accepts sections from it — silently replacing hand-written prose with a
 * fresh generation is the fastest way to make someone stop trusting the feature.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  acceptAllBlocks,
  diffDraftBlocks,
  mergeBlocks,
  PREAMBLE_ID,
} from "@/lib/skills/recording/draft-merge"

interface Props {
  current: string
  candidate: string
  onAccept: (content: string) => void
  onDiscard: () => void
}

export function DraftDiffView({ current, candidate, onAccept, onDiscard }: Props) {
  const t = useTranslations("skills.recorder.draft.diff")
  const [accepted, setAccepted] = useState<string[]>([])

  const diffs = useMemo(() => diffDraftBlocks(current, candidate), [current, candidate])
  const changed = diffs.filter((diff) => diff.change !== "unchanged")

  if (changed.length === 0) {
    return (
      <section className="space-y-2 rounded-lg border p-3">
        <p className="text-xs text-muted-foreground">{t("noChanges")}</p>
        <Button size="sm" variant="ghost" onClick={onDiscard}>
          {t("discard")}
        </Button>
      </section>
    )
  }

  const toggle = (id: string) =>
    setAccepted((prior) =>
      prior.includes(id) ? prior.filter((value) => value !== id) : [...prior, id]
    )

  return (
    <section className="space-y-3 rounded-lg border p-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => onAccept(acceptAllBlocks(candidate))}>
            {t("acceptAll")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={accepted.length === 0}
            onClick={() => onAccept(mergeBlocks(current, candidate, accepted))}
          >
            {t("acceptBlock")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDiscard}>
            {t("keepMine")}
          </Button>
        </div>
      </header>

      <ul className="space-y-2">
        {changed.map((diff) => {
          const isAccepted = accepted.includes(diff.id)
          return (
            <li
              key={diff.id}
              className={cn("rounded-md border p-2", isAccepted && "border-primary")}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium">
                  {diff.id === PREAMBLE_ID ? t("title") : diff.id}
                </span>
                <div className="flex items-center gap-2">
                  {diff.change === "added" ? (
                    <Badge variant="secondary">{t("sectionAdded")}</Badge>
                  ) : null}
                  {diff.change === "removed" ? (
                    <Badge variant="outline">{t("sectionRemoved")}</Badge>
                  ) : null}
                  <Button
                    size="sm"
                    variant={isAccepted ? "secondary" : "ghost"}
                    onClick={() => toggle(diff.id)}
                    aria-pressed={isAccepted}
                  >
                    {isAccepted ? t("acceptBlock") : t("keepMine")}
                  </Button>
                </div>
              </div>
              <div className="mt-1 grid gap-2 sm:grid-cols-2">
                <pre className="max-h-32 overflow-auto rounded bg-muted/40 p-1.5 text-[11px] whitespace-pre-wrap">
                  {diff.current?.body ?? ""}
                </pre>
                <pre className="max-h-32 overflow-auto rounded bg-muted/40 p-1.5 text-[11px] whitespace-pre-wrap">
                  {diff.candidate?.body ?? ""}
                </pre>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
