"use client"

/**
 * New issue from the phone (spec 2026-09-06 D8). The form collects the few
 * fields worth typing on a small screen and queues one `issue_create` job for
 * the host, where the identifier is allocated and the board's own create path
 * runs. The row appears here on the next pull, not on submit.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect } from "@/components/ui/native-select"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { queueIssueCreate } from "@/lib/issues/remote-write"
import {
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  type IssuePriority,
  type IssueProject,
  type IssueStatus,
} from "@/types/issues"

export interface IssueCreateSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Owning workspace id. */
  projectId: string | null
  projects: readonly IssueProject[]
}

export function IssueCreateSheet({ open, onOpenChange, projectId, projects }: IssueCreateSheetProps) {
  const t = useTranslations("issues")
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [issueProjectId, setIssueProjectId] = useState("")
  const [status, setStatus] = useState<IssueStatus>("todo")
  const [priority, setPriority] = useState<IssuePriority>("none")
  const [busy, setBusy] = useState(false)

  // Default to the first container once the list arrives, and follow it when
  // the chosen one disappears, but never override a choice that still exists.
  // Derived, not synced: an effect that writes state re-renders for nothing.
  const effectiveProjectId = projects.some((project) => project.id === issueProjectId)
    ? issueProjectId
    : (projects[0]?.id ?? "")

  async function submit() {
    if (!projectId || !effectiveProjectId) return
    setBusy(true)
    try {
      await queueIssueCreate({
        projectId,
        issueProjectId: effectiveProjectId,
        title,
        description,
        status,
        priority,
      })
      toast.success(t("mobile.createQueued", { title: title.trim() }))
      setTitle("")
      setDescription("")
      setStatus("todo")
      setPriority("none")
      onOpenChange(false)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const canSubmit = Boolean(projectId && effectiveProjectId && title.trim()) && !busy

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
        <SheetHeader className="px-0 pt-0">
          <SheetTitle>{t("create.title")}</SheetTitle>
        </SheetHeader>
        {projects.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="issues-mobile-create-no-project">
            {t("create.noProject")}
          </p>
        ) : (
          <form
            className="flex flex-col gap-3"
            data-testid="issues-mobile-create"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <p className="text-xs text-muted-foreground">{t("mobile.queuedHint")}</p>
            <div className="flex flex-col gap-1">
              <Label htmlFor="issue-mobile-create-title">{t("create.titleLabel")}</Label>
              <Input
                id="issue-mobile-create-title"
                value={title}
                autoFocus
                placeholder={t("create.titlePlaceholder")}
                onChange={(event) => setTitle(event.target.value)}
                data-testid="issues-mobile-create-title"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="issue-mobile-create-project">{t("create.projectLabel")}</Label>
              <NativeSelect
                id="issue-mobile-create-project"
                value={effectiveProjectId}
                onChange={(event) => setIssueProjectId(event.target.value)}
                data-testid="issues-mobile-create-project"
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="issue-mobile-create-status">{t("detail.status")}</Label>
                <NativeSelect
                  id="issue-mobile-create-status"
                  value={status}
                  onChange={(event) => setStatus(event.target.value as IssueStatus)}
                  data-testid="issues-mobile-create-status"
                >
                  {ISSUE_STATUSES.map((option) => (
                    <option key={option} value={option}>
                      {t(`status.${option}`)}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="issue-mobile-create-priority">{t("detail.priority")}</Label>
                <NativeSelect
                  id="issue-mobile-create-priority"
                  value={priority}
                  onChange={(event) => setPriority(event.target.value as IssuePriority)}
                  data-testid="issues-mobile-create-priority"
                >
                  {ISSUE_PRIORITIES.map((option) => (
                    <option key={option} value={option}>
                      {t(`priority.${option}`)}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="issue-mobile-create-description">{t("create.descriptionLabel")}</Label>
              <Textarea
                id="issue-mobile-create-description"
                value={description}
                rows={3}
                placeholder={t("detail.descriptionPlaceholder")}
                onChange={(event) => setDescription(event.target.value)}
                data-testid="issues-mobile-create-description"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                {t("create.cancel")}
              </Button>
              <Button type="submit" disabled={!canSubmit} data-testid="issues-mobile-create-submit">
                {t("create.submit")}
              </Button>
            </div>
          </form>
        )}
      </SheetContent>
    </Sheet>
  )
}
