"use client"

/**
 * Create a delivery container.
 *
 * There was no such surface. `createIssueProject` had exactly one caller —
 * the create-issue dialog, and only on the branch that fires when a workspace
 * has NO container yet. Combined with `deleteIssueProject` having no caller at
 * all, that meant a workspace got exactly one container, ever: the count could
 * never return to zero to re-open the path.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { createIssueProject, listTakenProjectKeys } from "@/lib/db/issue-projects"
import type { IssueProject } from "@/types/issues"
import {
  EMPTY_PROJECT_IDENTITY,
  ProjectIdentityFields,
  resolveProjectIdentity,
  type ProjectIdentityState,
} from "./project-identity-fields"

export interface CreateProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The owning WORKSPACE (`Issue.projectId`), not a container. */
  projectId: string
  onCreated?: (project: IssueProject) => void
}

export function CreateProjectDialog({
  open,
  onOpenChange,
  projectId,
  onCreated,
}: CreateProjectDialogProps) {
  const t = useTranslations("issues")
  const [identity, setIdentity] = useState<ProjectIdentityState>(EMPTY_PROJECT_IDENTITY)
  const [description, setDescription] = useState("")
  const [takenKeys, setTakenKeys] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)

  // Only the async load lives in an effect; the form resets on submit and on
  // close, which are both events.
  useEffect(() => {
    if (!open) return
    void listTakenProjectKeys().then(setTakenKeys)
  }, [open])

  const verdict = resolveProjectIdentity(identity, takenKeys)

  function reset() {
    setIdentity(EMPTY_PROJECT_IDENTITY)
    setDescription("")
  }

  async function submit() {
    setBusy(true)
    try {
      const project = await createIssueProject({
        projectId,
        name: identity.name.trim(),
        key: verdict.key,
        ...(description.trim() ? { description: description.trim() } : {}),
      })
      reset()
      onCreated?.(project)
      onOpenChange(false)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent data-testid="create-project-dialog">
        <DialogHeader>
          <DialogTitle>{t("projects.create")}</DialogTitle>
          <DialogDescription>{t("projects.createHint")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <ProjectIdentityFields
            value={identity}
            onChange={setIdentity}
            takenKeys={takenKeys}
            idPrefix="create-project"
            disabled={busy}
          />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-project-description">{t("projects.description")}</Label>
            <Textarea
              id="create-project-description"
              value={description}
              disabled={busy}
              onChange={(event) => setDescription(event.target.value)}
              // The description is shared with agents as context, so it is worth
              // saying so rather than leaving it looking decorative.
              placeholder={t("projects.descriptionHint")}
              rows={3}
              data-testid="create-project-description"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("create.cancel")}
          </Button>
          <Button
            disabled={!verdict.valid || busy}
            onClick={() => void submit()}
            data-testid="create-project-submit"
          >
            {t("projects.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
