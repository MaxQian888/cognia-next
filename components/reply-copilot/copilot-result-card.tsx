"use client"

/**
 * The reply copilot's result (ADR-0194): the judge's read of the conversation
 * and the ranked candidate replies. Shared by the composer dialog and the
 * desktop screen-chat overlay. Pure presentation — `onFill` / copy only put
 * text where the user can review it; nothing here sends.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, CopyIcon, CornerDownLeftIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useCopy } from "@/hooks/ui/use-copy"
import { cn } from "@/lib/utils"
import { dangerTone, type DangerTone } from "@/lib/reply-copilot/judgment"
import type { CopilotKnowledge } from "@/lib/reply-copilot/knowledge"
import type { CopilotResult, JudgeOutcome } from "@/lib/reply-copilot/run-copilot"

const TONE_CLASS: Record<DangerTone, string> = {
  calm: "border-emerald-500/40 text-emerald-700 dark:text-emerald-400",
  watch: "border-amber-500/40 text-amber-700 dark:text-amber-400",
  tense: "border-orange-500/50 text-orange-700 dark:text-orange-400",
  critical: "border-destructive/60 text-destructive",
}

function percent(value: number): number {
  return Math.round(value * 100)
}

function Judgment({ judge }: { judge: JudgeOutcome }) {
  const t = useTranslations("replyCopilot")
  if (judge.kind === "unavailable") {
    return (
      <p className="text-xs text-muted-foreground" data-testid="copilot-judge-unavailable">
        {t(`judge.unavailable.${judge.reason}`)}
      </p>
    )
  }
  if (judge.kind === "failed") {
    return (
      <p className="text-xs text-destructive" data-testid="copilot-judge-failed">
        {t("judge.failed", { reason: t(`errors.${judge.reason}`) })}
      </p>
    )
  }
  const { judgment } = judge
  const tone = judgment.danger ? dangerTone(judgment.danger.level) : null
  return (
    <div className="space-y-2" data-testid="copilot-judgment">
      <div className="flex flex-wrap items-center gap-1.5">
        {judgment.danger && tone ? (
          <Badge variant="outline" className={cn("font-medium", TONE_CLASS[tone])}>
            {t("judge.danger", { level: Math.round(judgment.danger.level) })} · {t(`tone.${tone}`)}
          </Badge>
        ) : null}
        {judgment.intent ? (
          <Badge variant="secondary">
            {t("judge.intentLabel")}: {t(`intent.${judgment.intent.key}`)}
          </Badge>
        ) : null}
        {judgment.need ? (
          <Badge variant="secondary">
            {t("judge.needLabel")}: {t(`need.${judgment.need.key}`)}
          </Badge>
        ) : null}
        {judgment.bestAction ? (
          <Badge variant="secondary">
            {t("judge.actionLabel")}: {t(`action.${judgment.bestAction.key}`)}
          </Badge>
        ) : null}
      </div>
      <ul className="space-y-0.5 text-xs text-muted-foreground">
        {judgment.literal !== null && judgment.literal < 0.5 ? (
          <li>{t("judge.subtext", { p: percent(1 - judgment.literal) })}</li>
        ) : null}
        {judgment.substanceNow !== null ? (
          <li>
            {judgment.substanceNow >= 0.5
              ? t("judge.substanceNow", { p: percent(judgment.substanceNow) })
              : t("judge.holdingLine", { p: percent(1 - judgment.substanceNow) })}
          </li>
        ) : null}
        {judgment.tensionResolved !== null ? (
          <li>
            {judgment.tensionResolved >= 0.5
              ? t("judge.tensionResolved")
              : t("judge.tensionOpen", { p: percent(1 - judgment.tensionResolved) })}
          </li>
        ) : null}
      </ul>
      {judge.truncated ? (
        <p className="text-xs text-muted-foreground">{t("judge.truncated")}</p>
      ) : null}
      {judge.backgroundDropped ? (
        <p className="text-xs text-muted-foreground">{t("judge.backgroundDropped")}</p>
      ) : null}
    </div>
  )
}

function Candidate({
  text,
  probability,
  best,
  onFill,
}: {
  text: string
  probability: number | null
  best: boolean
  onFill?: (text: string) => void
}) {
  const t = useTranslations("replyCopilot")
  const { copy, copied } = useCopy()
  return (
    <li
      className={cn("rounded-md border p-2", best && "border-primary/50 bg-primary/5")}
      data-testid="copilot-candidate"
    >
      <p className="text-sm whitespace-pre-wrap">{text}</p>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {probability !== null
            ? best
              ? t("drafts.best", { p: percent(probability) })
              : t("drafts.score", { p: percent(probability) })
            : null}
        </span>
        <div className="flex gap-1">
          {onFill ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => onFill(text)}>
              <CornerDownLeftIcon className="size-3.5" />
              {t("drafts.fill")}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void copy(text)}
            aria-label={t("drafts.copy")}
          >
            {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
            {copied ? t("drafts.copied") : t("drafts.copy")}
          </Button>
        </div>
      </div>
    </li>
  )
}

export interface CopilotResultCardProps {
  result: CopilotResult
  knowledge: CopilotKnowledge | null
  /** Put a candidate into the composer. Absent where there is no composer (overlay). */
  onFill?: (text: string) => void
}

export function CopilotResultCard({ result, knowledge, onFill }: CopilotResultCardProps) {
  const t = useTranslations("replyCopilot")
  const [expandedKnowledge, setExpandedKnowledge] = useState(false)
  const { drafts } = result
  return (
    <div className="space-y-3">
      <section className="space-y-1.5">
        <h4 className="text-xs font-medium text-muted-foreground">{t("judge.title")}</h4>
        <Judgment judge={result.judge} />
      </section>

      <section className="space-y-1.5">
        <h4 className="text-xs font-medium text-muted-foreground">{t("drafts.title")}</h4>
        {drafts.kind === "ok" ? (
          <>
            <ul className="space-y-1.5">
              {drafts.candidates.map((candidate, index) => (
                <Candidate
                  key={`${candidate.slot}-${candidate.text}`}
                  text={candidate.text}
                  probability={candidate.probability}
                  best={drafts.ranked && index === 0}
                  onFill={onFill}
                />
              ))}
            </ul>
            {!drafts.ranked ? (
              <p className="text-xs text-muted-foreground" data-testid="copilot-unranked">
                {drafts.rankError
                  ? t("drafts.unrankedError", { reason: t(`errors.${drafts.rankError}`) })
                  : t(`drafts.unrankedReason.${drafts.rankSkipped ?? "no_provider"}`)}
              </p>
            ) : null}
          </>
        ) : drafts.kind === "skipped" ? (
          <p className="text-xs text-muted-foreground">{t(`drafts.skipped.${drafts.reason}`)}</p>
        ) : (
          <p className="text-xs text-destructive">{t("drafts.failed")}</p>
        )}
      </section>

      {knowledge ? (
        <section className="text-xs text-muted-foreground">
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            onClick={() => setExpandedKnowledge((v) => !v)}
            aria-expanded={expandedKnowledge}
          >
            {t("knowledge.summary", {
              contact: knowledge.contactName ?? t("knowledge.unknownContact"),
              memory: knowledge.memoryLines,
            })}
          </button>
          {expandedKnowledge ? (
            <ul className="mt-1 space-y-0.5">
              <li>
                {knowledge.relationship
                  ? t("knowledge.relationship", { relationship: knowledge.relationship })
                  : t("knowledge.noRelationship")}
              </li>
              <li>{knowledge.hasNote ? t("knowledge.note") : t("knowledge.noNote")}</li>
              <li>
                {knowledge.memorySkipped
                  ? t(`knowledge.memorySkipped.${knowledge.memorySkipped}`)
                  : t("knowledge.memoryUsed", { count: knowledge.memoryLines })}
              </li>
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
