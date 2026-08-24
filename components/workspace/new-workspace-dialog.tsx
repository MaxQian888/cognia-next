"use client"

/**
 * "New workspace" — the create-a-directory counterpart to
 * {@link CloneRepositoryDialog}, which until now was the only flow in the app
 * that produced a directory that did not exist and ended at an activated
 * workspace. Same shape, with `mkdir` + an optional `git init` where the clone
 * has `git_clone`.
 *
 * Both filesystem steps go through `transport.call`, so this works unchanged
 * against a paired host: the directory is created on the machine that will run
 * the agent, not on the phone or browser that asked for it.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import { Spinner } from "@/components/ui/spinner"
import { DirectoryField } from "@/components/settings/common/directory-field"
import { createWorkspaceDir } from "@/lib/files/workspace-fs"
import { gitInit } from "@/lib/git/commands"
import { useSettingsStore } from "@/stores/settings"
import { createWorkspaceFromScratch } from "@/lib/workspace/create-workspace"
import { openPathAsWorkspace } from "@/lib/workspace/open-folder"
import { proposeWorkspacePath, resolveProjectsRoot } from "@/lib/workspace/projects-root"

export interface NewWorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fired after the workspace is created and activated. */
  onCreated?: (projectId: string) => void
  /** Injected in tests. */
  deps?: Parameters<typeof createWorkspaceFromScratch>[1]
  resolveParent?: (configured: string | null | undefined) => Promise<string | null>
}

const DEFAULT_DEPS: Parameters<typeof createWorkspaceFromScratch>[1] = {
  createDir: createWorkspaceDir,
  initGit: gitInit,
  openAsWorkspace: openPathAsWorkspace,
}

export function NewWorkspaceDialog({
  open,
  onOpenChange,
  onCreated,
  deps = DEFAULT_DEPS,
  resolveParent = resolveProjectsRoot,
}: NewWorkspaceDialogProps) {
  const t = useTranslations("workspace.create")
  const configuredRoot = useSettingsStore((s) => s.settings?.projectsRoot)
  const [name, setName] = useState("")
  const [parentDir, setParentDir] = useState("")
  const [initGit, setInitGit] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    void resolveParent(configuredRoot).then((resolved) => {
      if (alive && resolved) setParentDir((current) => current || resolved)
    })
    return () => {
      alive = false
    }
  }, [open, configuredRoot, resolveParent])

  const proposal = proposeWorkspacePath(parentDir, name)
  const canSubmit = proposal.ok && !busy

  function close() {
    if (busy) return
    setName("")
    setError(null)
    onOpenChange(false)
  }

  async function submit() {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const result = await createWorkspaceFromScratch({ parentDir, name, initGit }, deps)
      if (!result.ok) {
        setError(t(`errors.${result.reason}`))
        return
      }
      // A workspace whose `git init` failed is still a workspace — say so
      // rather than pretending it is a repository.
      if (result.gitInitError) setError(t("errors.gitInitFailed"))
      onCreated?.(result.project.id)
      setName("")
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent data-testid="new-workspace-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="new-workspace-name">{t("nameLabel")}</Label>
            <Input
              id="new-workspace-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("namePlaceholder")}
              disabled={busy}
              autoComplete="off"
              data-testid="new-workspace-name"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="new-workspace-parent">{t("parentLabel")}</Label>
            <DirectoryField
              value={parentDir}
              onChange={setParentDir}
              onCommit={setParentDir}
              ariaLabel={t("parentLabel")}
              browseLabel={t("browse")}
              disabled={busy}
            />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="new-workspace-git"
              checked={initGit}
              onCheckedChange={(next) => setInitGit(next === true)}
              disabled={busy}
            />
            <Label htmlFor="new-workspace-git" className="font-normal">
              {t("initGit")}
            </Label>
          </div>

          {/* The exact path is shown before anything is written, so a name the
              sanitizer had to rewrite is visible rather than a surprise. */}
          {proposal.ok && (
            <p className="text-xs text-muted-foreground break-all" data-testid="new-workspace-path">
              {proposal.path}
            </p>
          )}
          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {busy && <Spinner className="mr-2 size-4" />}
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
