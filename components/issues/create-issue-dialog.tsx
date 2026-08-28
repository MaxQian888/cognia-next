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
import { getCollabWorkspace } from "@/lib/db/collab-workspace-mirror"
import { enqueueCollabMutation } from "@/lib/db/mobile-outbound-queue"
import type { IssueActor, IssueProject, IssueStatus } from "@/types/issues"
import { AssigneePicker } from "./assignee-picker"
import {
  EMPTY_PROJECT_IDENTITY,
  ProjectIdentityFields,
  resolveProjectIdentity,
  type ProjectIdentityState,
} from "./projects/project-identity-fields"

/** Sentinel for the picker's "new container" row; `Select` needs a value. */
const NEW_PROJECT_VALUE = "__new__"

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

  /**
   * "Create a container as part of this issue" mode.
   *
   * It used to be exactly `projects.length === 0`, which — combined with
   * `/projects` having no create button and `deleteIssueProject` having no
   * caller — meant a workspace got ONE container ever: the count could never
   * fall back to zero to re-open the path. It is now available at any time,
   * from the "new container" row in the container picker.
   */
  const [creatingProject, setCreatingProject] = useState(false)
  const needsProject = projects.length === 0 || creatingProject
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [assignee, setAssignee] = useState<IssueActor | null>(null)
  const [issueProjectId, setIssueProjectId] = useState<string>("")
  const [identity, setIdentity] = useState<ProjectIdentityState>(EMPTY_PROJECT_IDENTITY)
  const [takenKeys, setTakenKeys] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sharedOrgId, setSharedOrgId] = useState<string | null>(null)
  const [destination, setDestination] = useState<"local" | "shared">("local")

  // Only the async load lives in an effect. The two things this used to reset
  // synchronously are better expressed without one: the default container is
  // derived below, and `submit` already clears the error before it writes.
  useEffect(() => {
    // Gated on the branch that uses them: the keys are only read to derive and
    // validate a NEW container's key, and the dialog usually just picks one.
    if (!open || !needsProject) return
    void listTakenProjectKeys().then(setTakenKeys)
  }, [open, needsProject])

  useEffect(() => {
    if (!open) return
    void getCollabWorkspace(projectId).then((workspace) => setSharedOrgId(workspace?.orgId ?? null))
  }, [open, projectId])

  /** Falls back to the first container until the user picks another. */
  const selectedProjectId = issueProjectId || (projects[0]?.id ?? "")

  /**
   * Name + key validation is shared with the projects console's own create
   * dialog. It used to be duplicated here, and the copies had already drifted:
   * this one passed `{example}` into `projects.keyHint` and the other did not,
   * so the other rendered the raw key path.
   */
  const identityVerdict = useMemo(
    () => resolveProjectIdentity(identity, takenKeys),
    [identity, takenKeys]
  )
  const canSubmit =
    title.trim().length > 0 &&
    !busy &&
    (needsProject ? identityVerdict.valid : Boolean(selectedProjectId))

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      if (destination === "shared") {
        if (!sharedOrgId || !selectedProjectId) throw new Error(t("create.sharedUnavailable"))
        await enqueueCollabMutation({
          command: "collab_issue_create",
          orgId: sharedOrgId,
          entityType: "issue",
          entityId: `new:${projectId}:${selectedProjectId}`,
          payload: {
            workspaceId: projectId,
            issueProjectId: selectedProjectId,
            title,
            ...(description.trim() ? { body: description.trim() } : {}),
            ...(assignee?.id ? { assignee } : {}),
            status,
          },
          label: title,
        })
        setTitle("")
        setDescription("")
        setAssignee(null)
        setDestination("local")
        onOpenChange(false)
        return
      }
      const containerId = needsProject
        ? (
            await createIssueProject({
              projectId,
              name: identity.name.trim(),
              key: identityVerdict.key || undefined,
            })
          ).id
        : selectedProjectId

      const issue = await createIssue({
        projectId,
        issueProjectId: containerId,
        title,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(assignee ? { assignee } : {}),
        status,
        createdBy: { kind: "human" },
      })

      setTitle("")
      setDescription("")
      setAssignee(null)
      setIdentity(EMPTY_PROJECT_IDENTITY)
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
          {sharedOrgId && projects.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="issue-destination">{t("create.destinationLabel")}</Label>
              <Select
                value={destination}
                onValueChange={(value) => setDestination(value as "local" | "shared")}
              >
                <SelectTrigger id="issue-destination" data-testid="create-issue-destination">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">{t("create.destinationLocal")}</SelectItem>
                  <SelectItem value="shared">{t("create.destinationShared")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {needsProject ? (
            <>
              {projects.length > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="-mb-2 w-fit px-0 text-xs"
                  onClick={() => setCreatingProject(false)}
                  data-testid="create-issue-project-cancel-new"
                >
                  {t("create.pickExistingProject")}
                </Button>
              ) : null}
              <ProjectIdentityFields
                value={identity}
                onChange={setIdentity}
                takenKeys={takenKeys}
                idPrefix="create-issue-project"
                disabled={busy}
              />
            </>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="issue-project">{t("create.projectLabel")}</Label>
              <Select
                value={selectedProjectId}
                onValueChange={(next) => {
                  if (next === NEW_PROJECT_VALUE) {
                    setDestination("local")
                    setCreatingProject(true)
                    return
                  }
                  setIssueProjectId(next)
                }}
              >
                <SelectTrigger id="issue-project" data-testid="create-issue-project">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name} ({project.key})
                    </SelectItem>
                  ))}
                  <SelectItem value={NEW_PROJECT_VALUE} data-testid="create-issue-project-new">
                    {t("create.newProject")}
                  </SelectItem>
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

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="issue-assignee">{t("detail.assignee")}</Label>
            <AssigneePicker
              id="issue-assignee"
              value={assignee}
              onChange={setAssignee}
              data-testid="create-issue-assignee"
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
