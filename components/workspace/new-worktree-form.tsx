"use client"

/**
 * "Add a worktree here" as a standalone form.
 *
 * It used to live inside `WorktreePanel`, which is a right-hand sheet reachable
 * only from Source Control. So the canonical inventory could list every
 * environment on the machine and offer no way to make one, and `/workspace`
 * had a Environments tab that was read-only for that reason alone.
 *
 * Extracted rather than copied: the branch/base/path triple, the
 * `runGitUserAction` approval wrapper and the picker-or-field rule are one
 * implementation with two mount points. Keeps the `sourceControl.worktrees.*`
 * namespace so no message key moves.
 */

import { useState } from "react"
import { FolderOpenIcon, GitBranchPlusIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { useDirectoryPicker } from "@/hooks/files/use-directory-picker"
import { gitWorktreeAdd, runGitUserAction } from "@/lib/git/commands"
import { isRemoteGitTarget } from "@/lib/git/target"
import { cn } from "@/lib/utils"
import { asGitError } from "@/types/git"

export interface NewWorktreeFormProps {
  rootDir: string
  /** Fired after a worktree is created, so the surrounding inventory reloads. */
  onCreated?: () => void
  /** The caller's own policy veto, ANDed with the host's. */
  canMutate?: (command: string) => boolean
  className?: string
}

function errorDetail(err: unknown): string {
  const payload = asGitError(err)
  if (payload?.detail) return payload.detail
  if (payload?.kind) return payload.kind
  return err instanceof Error ? err.message : String(err)
}

export function NewWorktreeForm({
  rootDir,
  onCreated,
  canMutate,
  className,
}: NewWorktreeFormProps) {
  const t = useTranslations("sourceControl")
  const [busy, setBusy] = useState(false)
  const [branch, setBranch] = useState("")
  const [baseRef, setBaseRef] = useState("")
  const [path, setPath] = useState("")
  const remote = isRemoteGitTarget(rootDir)
  const can = canMutate ?? (() => true)
  // "Is this target addressed by a relative path" and "does a directory picker
  // exist" are different questions. A button shown on the first question alone
  // opens nothing on web and mobile, and the read-only field beside it makes
  // the form uncompletable. The second question has one shared answer.
  const directoryPicker = useDirectoryPicker()
  const hasNativePicker = directoryPicker.available

  const chooseDirectory = async () => {
    try {
      const selected = await directoryPicker.browse()
      if (selected) setPath(selected)
    } catch (err) {
      toast.error(t("worktrees.error", { message: errorDetail(err) }))
    }
  }

  const createWorktree = async () => {
    const nextBranch = branch.trim()
    const nextPath = path.trim()
    if (!nextBranch || !nextPath || !can("git_worktree_add")) return
    setBusy(true)
    try {
      await runGitUserAction("git_worktree_add", () =>
        gitWorktreeAdd(rootDir, nextPath, nextBranch, baseRef.trim() || undefined, {
          source: "worktree-panel",
          ownerType: "user",
        })
      )
      setBranch("")
      setBaseRef("")
      setPath("")
      onCreated?.()
      toast.success(t("worktrees.created"))
    } catch (err) {
      toast.error(t("worktrees.error", { message: errorDetail(err) }))
    } finally {
      setBusy(false)
    }
  }

  const ready = Boolean(branch.trim() && path.trim())

  return (
    /*
      A container query, not a viewport one. The same form is mounted inside a
      sheet on the desktop, inside a card on `/workspace`, and inside a phone
      column, so the viewport never describes the width it actually has: the
      old single stack put three full-width fields and a full-width button into
      a 900px card, and the same stack into 320px.
    */
    <div
      className={cn("@container/worktree-form flex flex-col gap-3", className)}
      data-testid="new-worktree-form"
    >
      <div className="grid gap-3 @md/worktree-form:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="worktree-branch" className="text-xs">
            {t("worktrees.branchLabel")}
          </Label>
          <Input
            id="worktree-branch"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            placeholder={t("worktrees.branchPlaceholder")}
            className="h-8 font-mono text-xs"
            data-testid="worktree-branch"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="worktree-base-ref" className="text-xs">
            {t("worktrees.baseRefLabel")}
          </Label>
          <Input
            id="worktree-base-ref"
            value={baseRef}
            onChange={(event) => setBaseRef(event.target.value)}
            placeholder={t("worktrees.baseRefPlaceholder")}
            className="h-8 font-mono text-xs"
            data-testid="worktree-base-ref"
          />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="worktree-path" className="text-xs">
          {t("worktrees.pathLabel")}
        </Label>
        <div className="flex gap-2">
          <Input
            id="worktree-path"
            value={path}
            // Read-only only where the picker fills it in.
            readOnly={!remote && hasNativePicker}
            onChange={(event) => (remote || !hasNativePicker) && setPath(event.target.value)}
            placeholder={
              remote ? t("worktrees.relativePathPlaceholder") : t("worktrees.pathPlaceholder")
            }
            className="h-8 min-w-0 font-mono text-xs"
            data-testid="worktree-path"
          />
          {!remote && hasNativePicker ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 shrink-0"
              onClick={() => void chooseDirectory()}
              disabled={busy}
              data-testid="worktree-pick-directory"
            >
              <FolderOpenIcon aria-hidden className="size-3.5" />
              {t("worktrees.chooseDirectory")}
            </Button>
          ) : null}
        </div>
      </div>
      {/*
        The submit sits at the end of its own row rather than spanning the
        form. A full-width primary button under three fields reads as the
        page's main action; this one only ever applies to the form above it.
      */}
      <div className="flex justify-end">
        <Button
          size="sm"
          className="h-8 gap-1.5"
          onClick={() => void createWorktree()}
          disabled={busy || !ready || !can("git_worktree_add")}
          data-testid="worktree-create"
        >
          {busy ? (
            <Spinner className="size-3.5" />
          ) : (
            <GitBranchPlusIcon aria-hidden className="size-3.5" />
          )}
          {t("worktrees.create")}
        </Button>
      </div>
    </div>
  )
}
