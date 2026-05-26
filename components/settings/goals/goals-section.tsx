"use client"

/**
 * Settings → Goals — a thin launcher into the standalone `/goals` console
 * (ADR-0019 Phase 3). The full management surface (open goals, history,
 * templates, defaults, tracker) lives at `/goals`; this preserves the
 * `goals` settings section + its deep-link contract while pointing users at
 * the richer console. The built-in tracker stays inline so users who land
 * here still see it without a hop.
 */

import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { TargetIcon, ExternalLinkIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { GoalTrackerConfig } from "./goal-tracker-config"

export function GoalsSection() {
  const t = useTranslations("goal")
  const router = useRouter()
  return (
    <div className="space-y-4" data-testid="goals-section">
      <header className="flex items-center gap-2">
        <TargetIcon className="size-5 text-primary" aria-hidden />
        <div>
          <h2 className="text-lg font-semibold">{t("launcher.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("launcher.description")}</p>
        </div>
      </header>
      <Button onClick={() => router.push("/goals")} data-testid="goals-open-console">
        <ExternalLinkIcon className="size-4" aria-hidden />
        {t("launcher.open")}
      </Button>
      <GoalTrackerConfig />
    </div>
  )
}
