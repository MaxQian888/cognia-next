"use client"

import { useState } from "react"
import { SparklesIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  isSkillSuggestionEligible,
  prepareSkillRecordingFromSource,
  type SkillSuggestionOutcome,
  type SkillSuggestionSource,
} from "@/lib/skills/session-suggestion"

export function SkillSuggestionCard({
  source,
  outcome,
}: {
  source: SkillSuggestionSource
  outcome: SkillSuggestionOutcome
}) {
  const t = useTranslations("sessionInsights")
  const [preparing, setPreparing] = useState(false)

  if (!isSkillSuggestionEligible(outcome)) return null

  const confirm = async () => {
    setPreparing(true)
    try {
      await prepareSkillRecordingFromSource(source)
      toast.success(t("skillSuggestion.ready"))
    } catch {
      toast.error(t("skillSuggestion.error"))
    } finally {
      setPreparing(false)
    }
  }

  return (
    <Card className="space-y-2 border-primary/20 bg-primary/5 p-3" data-testid="skill-suggestion">
      <div className="flex items-start gap-2">
        <SparklesIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium">{t("skillSuggestion.title")}</p>
          <p className="text-xs text-muted-foreground">{t("skillSuggestion.description")}</p>
          <p className="text-[10px] text-muted-foreground">{t("skillSuggestion.privacy")}</p>
        </div>
      </div>
      <Button size="sm" disabled={preparing} onClick={() => void confirm()}>
        {preparing ? t("skillSuggestion.preparing") : t("skillSuggestion.action")}
      </Button>
    </Card>
  )
}
