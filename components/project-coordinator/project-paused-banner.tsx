"use client"

/**
 * Says a project is paused and offers Resume (ADR-0204). Mounted above the
 * composer of a coordinator or thread, where a send would otherwise be refused
 * with no way forward, and in the workspace's coordination card. Renders
 * nothing while the project runs.
 */

import { useFormatter, useNow, useTranslations } from "next-intl"
import { PauseCircleIcon, PlayIcon } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { useProjectPause } from "@/hooks/project-coordinator/use-project-pause"

export interface ProjectPausedBannerProps {
  projectId: string
  className?: string
}

export function ProjectPausedBanner({ projectId, className }: ProjectPausedBannerProps) {
  const t = useTranslations("projectCoordinator.pause")
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const { paused, busy, resume } = useProjectPause(projectId)
  if (!paused) return null

  return (
    <Alert className={className} data-testid="project-paused-banner">
      <PauseCircleIcon />
      <AlertTitle>{t("bannerTitle")}</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span>
          {t("bannerBody", { since: format.relativeTime(paused.at, now) })}
          {paused.reason ? ` ${t("reason", { reason: paused.reason })}` : null}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void resume()}
          data-testid="project-resume"
        >
          <PlayIcon aria-hidden className="size-3.5" />
          {t("resume")}
        </Button>
      </AlertDescription>
    </Alert>
  )
}
