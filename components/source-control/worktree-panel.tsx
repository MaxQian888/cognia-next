"use client"

/** Manual worktree creation shell around the canonical workspace inventory. */

import { useState } from "react"
import { FolderOpenIcon, GitBranchPlusIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { WorkspaceEnvironmentList } from "@/components/workspace/workspace-environment-list"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { pickDirectory } from "@/lib/files/file-bridge"
import { gitWorktreeAdd, runGitUserAction } from "@/lib/git/commands"
import { isRemoteGitTarget } from "@/lib/git/target"
import { asGitError } from "@/types/git"

interface WorktreePanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  rootDir: string
  canMutate?: (command: string) => boolean
}

function errorDetail(err: unknown): string {
  const payload = asGitError(err)
  if (payload?.detail) return payload.detail
  if (payload?.kind) return payload.kind
  return err instanceof Error ? err.message : String(err)
}

export function WorktreePanel({ open, onOpenChange, rootDir, canMutate }: WorktreePanelProps) {
  const t = useTranslations("sourceControl")
  const [busy, setBusy] = useState(false)
  const [branch, setBranch] = useState("")
  const [baseRef, setBaseRef] = useState("")
  const [path, setPath] = useState("")
  const [refreshKey, setRefreshKey] = useState(0)
  const remote = isRemoteGitTarget(rootDir)
  const can = canMutate ?? (() => true)

  const chooseDirectory = async () => {
    try {
      const selected = await pickDirectory()
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
      setRefreshKey((current) => current + 1)
      toast.success(t("worktrees.created"))
    } catch (err) {
      toast.error(t("worktrees.error", { message: errorDetail(err) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-[30rem] flex-col" data-testid="worktree-panel">
        <SheetHeader>
          <SheetTitle>{t("worktrees.title")}</SheetTitle>
          <SheetDescription>{t("worktrees.description")}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-3 border-b p-4">
          <div className="grid gap-1.5">
            <Label htmlFor="worktree-branch">{t("worktrees.branchLabel")}</Label>
            <Input
              id="worktree-branch"
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              placeholder={t("worktrees.branchPlaceholder")}
              data-testid="worktree-branch"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="worktree-base-ref">{t("worktrees.baseRefLabel")}</Label>
            <Input
              id="worktree-base-ref"
              value={baseRef}
              onChange={(event) => setBaseRef(event.target.value)}
              placeholder={t("worktrees.baseRefPlaceholder")}
              data-testid="worktree-base-ref"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="worktree-path">{t("worktrees.pathLabel")}</Label>
            <div className="flex gap-2">
              <Input
                id="worktree-path"
                value={path}
                readOnly={!remote}
                onChange={(event) => remote && setPath(event.target.value)}
                placeholder={
                  remote ? t("worktrees.relativePathPlaceholder") : t("worktrees.pathPlaceholder")
                }
                className="min-w-0"
                data-testid="worktree-path"
              />
              {!remote ? (
                <Button
                  type="button"
                  variant="outline"
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
          <Button
            onClick={() => void createWorktree()}
            disabled={busy || !branch.trim() || !path.trim() || !can("git_worktree_add")}
            className="gap-1.5"
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

        <ScrollArea className="min-h-0 flex-1">
          <div className="p-4">
            <WorkspaceEnvironmentList
              presentation="sheet"
              rootDir={rootDir}
              refreshKey={refreshKey}
              showPrune
              canMutate={can}
            />
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
