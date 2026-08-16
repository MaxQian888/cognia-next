"use client"

/**
 * Create an issue — and, when the workspace has no delivery container yet, the
 * project to put it in.
 *
 * Issues cannot exist without a project (the project owns the identifier key
 * and the identifier counter), so a first-run user would otherwise hit a dead
 * end: an empty board with a "New issue" button that can't complete. Rather
 * than a second dialog, this one grows a project field when the workspace is
 * empty and derives the key from the name, which is the only moment the key
 * can still be chosen.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { createIssue } from "@/lib/db/issues"
import { createIssueProject, listTakenProjectKeys } from "@/lib/db/issue-projects"
import { deriveProjectKey, isValidProjectKey } from "@/lib/issues/identifier"
import type { IssueProject, IssueStatus } from "@/types/issues"

export interface CreateIssueDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Owning workspace id. */
  projectId: string
  projects: readonly IssueProject[]
  /** Column the user clicked "+" on. */
  status?: IssueStatus
  onCreated?: (issueId: string) => void
}

export function CreateIssueDialog({
  open,
  onOpenChange,
  projectId,
  projects,
  status = "backlog",
  onCreated,
}: CreateIssueDialogProps) {
  const t = useTranslations("issues")

  const needsProject = projects.length === 0
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [issueProjectId, setIssueProjectId] = useState<string>("")
  const [projectName, setProjectName] = useState("")
  const [projectKeyInput, setProjectKeyInput] = useState("")
  const [keyTouched, setKeyTouched] = useState(false)
  const [takenKeys, setTakenKeys] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Only the async load lives in an effect. The two things this used to reset
  // synchronously are better expressed without one: the default container is
  // derived below, and `submit` already clears the error before it writes.
  useEffect(() => {
    if (!open) return
    void listTakenProjectKeys().then(setTakenKeys)
  }, [open])

  /** Falls back to the first container until the user picks another. */
  const selectedProjectId = issueProjectId || (projects[0]?.id ?? "")

  /**
   * The key is DERIVED from the project name until the user edits it, rather
   * than mirrored into state by an effect. Suggesting it in an effect meant a
   * `setState` in the effect body — a cascading render on every keystroke, and
   * the source of truth living in two places at once.
   */
  const derivedKey = useMemo(
    () => (projectName.trim() ? deriveProjectKey(projectName, takenKeys) : ""),
    [projectName, takenKeys]
  )
  const projectKey = keyTouched ? projectKeyInput : derivedKey

  const keyInvalid = needsProject && projectKey.length > 0 && !isValidProjectKey(projectKey)
  const keyTaken = needsProject && takenKeys.has(projectKey)
  const canSubmit =
    title.trim().length > 0 &&
    !busy &&
    (needsProject
      ? projectName.trim().length > 0 && !keyInvalid && !keyTaken
      : Boolean(selectedProjectId))

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const containerId = needsProject
        ? (await createIssueProject({ projectId, name: projectName, key: projectKey || undefined }))
            .id
        : selectedProjectId

      const issue = await createIssue({
        projectId,
        issueProjectId: containerId,
        title,
        ...(description.trim() ? { description: description.trim() } : {}),
        status,
        createdBy: { kind: "human" },
      })

      setTitle("")
      setDescription("")
      setProjectName("")
      setProjectKeyInput("")
      setKeyTouched(false)
      onCreated?.(issue.id)
      onOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="create-issue-dialog">
        <DialogHeader>
          <DialogTitle>{t("create.title")}</DialogTitle>
          {needsProject ? <DialogDescription>{t("create.noProject")}</DialogDescription> : null}
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {needsProject ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="issue-project-name">{t("projects.nameLabel")}</Label>
                <Input
                  id="issue-project-name"
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  placeholder={t("projects.namePlaceholder")}
                  data-testid="create-issue-project-name"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="issue-project-key">{t("projects.keyLabel")}</Label>
                <Input
                  id="issue-project-key"
                  value={projectKey}
                  onChange={(event) => {
                    setKeyTouched(true)
                    setProjectKeyInput(event.target.value.toUpperCase())
                  }}
                  maxLength={5}
                  className="w-28 font-mono"
                  data-testid="create-issue-project-key"
                />
                <p className="text-xs text-muted-foreground">
                  {keyInvalid
                    ? t("projects.keyInvalid")
                    : keyTaken
                      ? t("projects.keyTaken")
                      : t("projects.keyHint", { example: `${projectKey || "KEY"}-1` })}
                </p>
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="issue-project">{t("create.projectLabel")}</Label>
              <Select value={selectedProjectId} onValueChange={setIssueProjectId}>
                <SelectTrigger id="issue-project" data-testid="create-issue-project">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name} ({project.key})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="issue-title">{t("create.titleLabel")}</Label>
            <Input
              id="issue-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t("create.titlePlaceholder")}
              data-testid="create-issue-title"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="issue-description">{t("create.descriptionLabel")}</Label>
            <Textarea
              id="issue-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              data-testid="create-issue-description"
            />
          </div>

          {error ? (
            <p className="text-sm text-destructive" data-testid="create-issue-error">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("create.cancel")}
          </Button>
          <Button onClick={submit} disabled={!canSubmit} data-testid="create-issue-submit">
            {t("create.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
