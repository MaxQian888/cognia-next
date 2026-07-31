"use client"

import { useTranslations } from "next-intl"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import type { Loop } from "@/types/loop"

interface Props {
  loop: Loop
}

export function LoopOverviewTab({ loop }: Props) {
  const t = useTranslations("loop")
  const iterPct = Math.min(100, (loop.iterations / loop.config.maxIterations) * 100)
  const tokenPct = Math.min(100, (loop.tokensUsed / loop.config.maxTokens) * 100)

  return (
    <div className="space-y-4 text-sm">
      <div>
        <span className="text-xs text-muted-foreground">{t("overview.prompt")}</span>
        <p className="mt-1 whitespace-pre-wrap">{loop.safePrompt}</p>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge variant="outline">
          {t("overview.statusBadge", { status: t(`status.${loop.status}`) })}
        </Badge>
        <Badge variant="outline" data-testid="loop-mode-badge">
          {loop.mode === "interval"
            ? t("overview.modeInterval", {
                minutes: Math.max(1, Math.round((loop.intervalMs ?? 0) / 60_000)),
              })
            : t("overview.modeSelfPaced")}
        </Badge>
        <Badge variant="outline">
          {t("overview.createdBadge", { date: new Date(loop.createdAt).toLocaleString() })}
        </Badge>
        {loop.expiresAt && !loop.endedAt && (
          <Badge variant="outline">
            {t("overview.expiresBadge", { date: new Date(loop.expiresAt).toLocaleString() })}
          </Badge>
        )}
        {loop.endedAt && (
          <Badge variant="outline">
            {t("overview.endedBadge", { date: new Date(loop.endedAt).toLocaleString() })}
          </Badge>
        )}
      </div>
      <div className="space-y-1.5">
        <div className="flex justify-between text-xs">
          <span>{t("overview.iterations")}</span>
          <span>
            {loop.iterations} / {loop.config.maxIterations}
          </span>
        </div>
        <Progress value={iterPct} aria-label={t("overview.iterationBudgetAria")} />
      </div>
      <div className="space-y-1.5">
        <div className="flex justify-between text-xs">
          <span>{t("overview.tokens")}</span>
          <span>
            {loop.tokensUsed.toLocaleString()} / {loop.config.maxTokens.toLocaleString()}
          </span>
        </div>
        <Progress value={tokenPct} aria-label={t("overview.tokenBudgetAria")} />
      </div>
      {loop.mode === "self_paced" && loop.nextDelayReason && (
        <div>
          <span className="text-xs text-muted-foreground">{t("overview.lastDelayReason")}</span>
          <p className="mt-1 italic">{`“${loop.nextDelayReason}”`}</p>
        </div>
      )}
    </div>
  )
}
