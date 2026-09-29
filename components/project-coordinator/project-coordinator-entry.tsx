"use client"

/**
 * The workspace's door into project coordination (ADR-0204): turn it on, see
 * the goal, open the coordinator. The threads board sits beside it once on.
 * Settings (goal, limits, execution) live in the workspace manager — one
 * editor, reached from its existing "Manage" entry.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { MessagesSquareIcon, PowerIcon, SparklesIcon } from "lucide-react"
import { ConsoleSection } from "@/components/surface/console-section"
import { Button } from "@/components/ui/button"
import { sessionHref } from "@/lib/issues/run/agent-task-adapter"
import { resolveCoordinatorConfig } from "@/lib/project-coordinator/config"
import {
  disableProjectCoordination,
  enableProjectCoordination,
} from "@/lib/project-coordinator/user-actions"
import { ensureCoordinatorSession } from "@/lib/project-coordinator/coordinator-session"
import { useProjectStore } from "@/stores/project/project-store"

export interface ProjectCoordinatorEntryProps {
  workspaceId: string
}

export function ProjectCoordinatorEntry({ workspaceId }: ProjectCoordinatorEntryProps) {
  const t = useTranslations("projectCoordinator.entry")
  const router = useRouter()
  const project = useProjectStore((s) => s.projects.find((p) => p.id === workspaceId))
  const config = resolveCoordinatorConfig(project)
  const [busy, setBusy] = useState(false)

  const openCoordinator = async (enable: boolean) => {
    if (busy) return
    setBusy(true)
    try {
      const coordinator = enable
        ? await enableProjectCoordination(workspaceId, t("coordinatorTitle"))
        : await ensureCoordinatorSession({ projectId: workspaceId, title: t("coordinatorTitle") })
      router.push(sessionHref(coordinator.id))
    } catch (error) {
      toast.error(
        t("enableFailed", { error: error instanceof Error ? error.message : String(error) })
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <ConsoleSection
      id="project-coordination"
      pane="workspace-pane"
      idPrefix="workspace-section"
      icon={SparklesIcon}
      title={t("title")}
      meta={
        config.enabled ? (
          <span className="flex items-center gap-1">
            {config.icon ? <span aria-hidden>{config.icon}</span> : null}
            <Button
              size="sm"
              variant="ghost"
              className="-my-1 h-7 gap-1 text-muted-foreground"
              onClick={() => disableProjectCoordination(workspaceId)}
              data-testid="project-coordination-disable"
            >
              <PowerIcon aria-hidden className="size-3.5" />
              {t("disable")}
            </Button>
          </span>
        ) : undefined
      }
    >
      {config.enabled ? (
        <div className="flex flex-col gap-3" data-testid="project-coordination-on">
          <div className="text-xs">
            <div className="font-medium text-muted-foreground">{t("goal")}</div>
            <p className={config.goal ? "text-sm" : "text-muted-foreground"}>
              {config.goal ?? t("noGoal")}
            </p>
          </div>
          <Button
            size="sm"
            className="self-start"
            disabled={busy}
            onClick={() => void openCoordinator(false)}
            data-testid="project-coordination-open"
          >
            <MessagesSquareIcon aria-hidden className="size-3.5" />
            {t("open")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3" data-testid="project-coordination-off">
          <p className="text-xs text-muted-foreground">{t("description")}</p>
          <Button
            size="sm"
            className="self-start"
            disabled={busy}
            onClick={() => void openCoordinator(true)}
            data-testid="project-coordination-enable"
          >
            <SparklesIcon aria-hidden className="size-3.5" />
            {t("enable")}
          </Button>
        </div>
      )}
    </ConsoleSection>
  )
}
