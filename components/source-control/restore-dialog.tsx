"use client"

/**
 * RestoreDialog — restore a single file's working-tree content from a chosen
 * source ref (HEAD, a branch, a tag, or any commit-ish). This is what makes
 * Restore distinct from Discard (which only reverts to the index): you can pull
 * an older revision of one file back into the working tree.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { gitRefs } from "@/lib/git/commands"
import { useGitRead } from "@/hooks/git/use-git-read"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"
import { ReadError } from "./read-error"

interface RestoreDialogProps {
  rootDir: string
  /** File to restore; `null` keeps the dialog closed. */
  path: string | null
  onOpenChange: (open: boolean) => void
  actions: Pick<UseGitActionsResult, "restore"> & Partial<Pick<UseGitActionsResult, "can">>
}

export function RestoreDialog({ rootDir, path, onOpenChange, actions }: RestoreDialogProps) {
  const t = useTranslations("sourceControl")
  const [source, setSource] = useState("HEAD")
  const can = actions.can ?? (() => true)

  // Reset the source to HEAD when a new file opens — done in render via a
  // previous-value guard (not an effect) to avoid set-state-in-effect.
  const [prevPath, setPrevPath] = useState(path)
  if (prevPath !== path) {
    setPrevPath(path)
    setSource("HEAD")
  }

  // Suggestions for the source field. The field takes any commit-ish, so a
  // failed read costs the suggestions, not the restore, and says so.
  const refsRead = useGitRead(`${rootDir}\u0000refs`, () => gitRefs(rootDir), {
    enabled: path !== null,
  })
  const refs = refsRead.data ?? []

  const doRestore = useCallback(async () => {
    if (!path) return
    const failure = await actions.restore([path], false, source.trim() || "HEAD")
    if (failure) return
    onOpenChange(false)
  }, [path, source, actions, onOpenChange])

  return (
    <Dialog open={path !== null} onOpenChange={onOpenChange}>
      <DialogContent data-testid="restore-dialog">
        <DialogHeader>
          <DialogTitle>{t("restore.title")}</DialogTitle>
          <DialogDescription className="truncate">
            {t("restore.description", { path: path ?? "" })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="restore-source">{t("restore.source")}</Label>
          <Input
            id="restore-source"
            list="restore-source-refs"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder={t("restore.sourcePlaceholder")}
            data-testid="restore-source-input"
          />
          <datalist id="restore-source-refs">
            <option value="HEAD" />
            {refs.map((r) => (
              <option key={`${r.kind}:${r.name}`} value={r.name} />
            ))}
          </datalist>
          {refsRead.error ? (
            <ReadError
              message={refsRead.error}
              onRetry={refsRead.retry}
              className="px-0"
              testId="restore-refs-error"
            />
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("restore.cancel")}
          </Button>
          <Button
            onClick={() => void doRestore()}
            disabled={!can("git_restore")}
            data-testid="restore-confirm"
          >
            {t("restore.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
