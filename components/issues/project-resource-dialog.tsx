"use client"

/**
 * Bind a resource to a delivery container.
 *
 * Two kinds, and the difference matters:
 *
 *   - `github-repo`   — the only syncable one. Adding the first repo anywhere
 *                       creates the background refresh task; removing the last
 *                       one deletes it (`lib/issues/github-sync-schedule.ts`).
 *   - `workspace-root`— a REFERENCE to a directory the workspace has already
 *                       mounted. This dialog cannot mount one: mounting goes
 *                       through `lib/workspace/trust-gate.ts`, and a second
 *                       mount path here would be a way around the trust gate.
 *                       So an unmounted directory is not offered at all.
 *
 * A repo may be bound once per install. Mirror rows are keyed `owner/repo#n`
 * and carry a single `issueProjectId`, so a second binding would have each sync
 * steal every row from the other container.
 */

import { useMemo, useState } from "react"
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
import { addIssueProjectResource } from "@/lib/db/issue-projects"
import { syncGithubIssueSchedule } from "@/lib/issues/github-sync-schedule"
import type { IssueProjectResource } from "@/types/issues"
import type { WorkspaceRoot } from "@/types/workspace"

/** `owner/name`, the only form the GitHub API accepts for a repo path. */
export const REPO_FULL_NAME_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

export type ResourceKind = IssueProjectResource["kind"]

export interface ProjectResourceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Container to bind to. */
  issueProjectId: string
  /** Directories the workspace has already mounted — the only ones offerable. */
  roots: readonly WorkspaceRoot[]
  /** Repos already bound anywhere, so a second binding can be refused up front. */
  boundRepos?: ReadonlySet<string>
  /** Root ids already referenced by THIS container. */
  boundRootIds?: ReadonlySet<string>
  onAdded?: (resource: IssueProjectResource) => void
}

export function ProjectResourceDialog({
  open,
  onOpenChange,
  issueProjectId,
  roots,
  boundRepos,
  boundRootIds,
  onAdded,
}: ProjectResourceDialogProps) {
  const t = useTranslations("issues")

  const [kind, setKind] = useState<ResourceKind>("github-repo")
  const [repo, setRepo] = useState("")
  const [rootId, setRootId] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const availableRoots = useMemo(
    () => roots.filter((root) => !boundRootIds?.has(root.id)),
    [roots, boundRootIds]
  )

  /**
   * Cleared on the way out rather than by an effect watching `open`: an effect
   * that calls setState is a cascading render, and routing every close path —
   * cancel, Escape, overlay click, successful submit — through `close()` keeps
   * the draft from outliving the dialog without one.
   */
  function close() {
    setRepo("")
    setRootId("")
    setError(null)
    onOpenChange(false)
  }

  const trimmedRepo = repo.trim()
  const repoInvalid = trimmedRepo.length > 0 && !REPO_FULL_NAME_PATTERN.test(trimmedRepo)
  const repoTaken = boundRepos?.has(trimmedRepo) ?? false
  const selectedRootId = rootId || (availableRoots[0]?.id ?? "")

  const canSubmit =
    !busy &&
    (kind === "github-repo"
      ? trimmedRepo.length > 0 && !repoInvalid && !repoTaken
      : selectedRootId.length > 0)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const resource: IssueProjectResource =
        kind === "github-repo"
          ? { kind: "github-repo", repoFullName: trimmedRepo, addedAt: Date.now() }
          : { kind: "workspace-root", rootId: selectedRootId, addedAt: Date.now() }

      await addIssueProjectResource(issueProjectId, resource)
      // Adding the first repo is what brings the background refresh into
      // existence. Doing it here rather than at boot means a user who binds a
      // repo sees the board stay fresh without restarting.
      if (resource.kind === "github-repo") await syncGithubIssueSchedule()

      onAdded?.(resource)
      close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true)
        else close()
      }}
    >
      <DialogContent data-testid="project-resource-dialog">
        <DialogHeader>
          <DialogTitle>{t("projects.addResource")}</DialogTitle>
          <DialogDescription>{t("projects.addResourceHint")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="resource-kind">{t("projects.resourceKind")}</Label>
            <Select value={kind} onValueChange={(value) => setKind(value as ResourceKind)}>
              <SelectTrigger id="resource-kind" data-testid="resource-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="github-repo">{t("projects.resourceRepo")}</SelectItem>
                <SelectItem value="workspace-root">{t("projects.resourceDirectory")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {kind === "github-repo" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="resource-repo">{t("projects.resourceRepo")}</Label>
              <Input
                id="resource-repo"
                value={repo}
                onChange={(event) => setRepo(event.target.value)}
                placeholder={t("projects.repoPlaceholder")}
                className="font-mono"
                data-testid="resource-repo"
              />
              <p className="text-xs text-muted-foreground" data-testid="resource-repo-hint">
                {repoInvalid
                  ? t("projects.repoInvalid")
                  : repoTaken
                    ? t("projects.repoTaken")
                    : t("projects.repoHint")}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="resource-root">{t("projects.resourceDirectory")}</Label>
              {availableRoots.length === 0 ? (
                <p className="text-xs text-muted-foreground" data-testid="resource-no-roots">
                  {t("projects.noRootsAvailable")}
                </p>
              ) : (
                <Select value={selectedRootId} onValueChange={setRootId}>
                  <SelectTrigger id="resource-root" data-testid="resource-root">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availableRoots.map((root) => (
                      <SelectItem key={root.id} value={root.id}>
                        {root.label ?? root.path}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className="text-xs text-muted-foreground">{t("projects.directoryHint")}</p>
            </div>
          )}

          {error ? (
            <p className="text-sm text-destructive" data-testid="resource-error">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t("create.cancel")}
          </Button>
          <Button onClick={submit} disabled={!canSubmit} data-testid="resource-submit">
            {t("projects.addResource")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
