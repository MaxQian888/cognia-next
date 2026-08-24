"use client"

/**
 * The working-directory line in the first-run step.
 *
 * A brand-new install ends up on the `Default` workspace, which has no roots,
 * with `defaultWorkingDir` unset — so `resolveEffectiveCwd` resolves to nothing
 * and the first thing the agent is asked to do with a file fails. This is the
 * one screen where that is fixable before it bites.
 *
 * Deliberately a LINE, not a gate: the starter cards stay usable without it
 * (the folder card asks for a directory itself), so a user who wants to see
 * output first is not stopped. Both paths through setup render the same
 * first-run element, so mounting here covers the recommended path too.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, FolderOpenIcon, FolderPlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { NewWorkspaceDialog } from "@/components/workspace/new-workspace-dialog"
import { isTauri } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { openFolderAsWorkspace } from "@/lib/workspace/open-folder"
import { primaryRootOf } from "@/lib/workspace/roots"
import { useProjectStore } from "@/stores/project/project-store"

export interface WorkspaceSetupProps {
  /** Injected in tests. */
  openFolder?: () => Promise<unknown>
  hasNativePicker?: () => boolean
}

export function WorkspaceSetup({
  openFolder = openFolderAsWorkspace,
  hasNativePicker = isTauri,
}: WorkspaceSetupProps = {}) {
  const t = useTranslations("onboarding.workspace")
  const root = useProjectStore((s) => {
    const active = s.projects.find((project) => project.id === s.activeProjectId)
    return active ? primaryRootOf(active)?.path : undefined
  })
  const [createOpen, setCreateOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  async function browse() {
    setBusy(true)
    try {
      await openFolder()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2"
      data-testid="onboarding-workspace"
    >
      <div className="flex min-w-0 flex-1 shrink items-center gap-2">
        {root && <CheckIcon className="size-4 shrink-0 text-brand-action" />}
        <div className="min-w-0">
          <p className="truncate text-sm">{root ? t("readyTitle") : t("emptyTitle")}</p>
          <p
            className="truncate text-xs text-muted-foreground"
            data-testid="onboarding-workspace-root"
          >
            {root ?? t("emptyDescription")}
          </p>
        </div>
      </div>

      {hasNativePicker() && (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={busy}
          onClick={() => void browse()}
          data-testid="onboarding-workspace-open"
        >
          <FolderOpenIcon className="size-4" />
          {t("open")}
        </Button>
      )}
      <Button
        variant={root ? "outline" : "default"}
        size="sm"
        className={cn("shrink-0")}
        disabled={busy}
        onClick={() => setCreateOpen(true)}
        data-testid="onboarding-workspace-create"
      >
        <FolderPlusIcon className="size-4" />
        {t("create")}
      </Button>

      <NewWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  )
}
