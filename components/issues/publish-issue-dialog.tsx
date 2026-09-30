"use client"

/**
 * Publish a local issue to a remote tracker.
 *
 * The counterpart of `LinkGithubIssueDialog`: that one binds an issue to a
 * remote item that already exists, this one creates the remote item. The exact
 * title and body are shown before anything is sent — creating an issue on
 * GitHub or a task in Lark is an external write this dialog cannot undo — and
 * the targets are the container's own bindings, never free text.
 */

import { useState } from "react"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { GithubWritebackError } from "@/lib/issues/github-writeback"
import { publishIssue, type PublishTarget } from "@/lib/issues/publish"

export interface PublishIssueDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  issue: { id: string; title: string; description?: string }
  targets: readonly PublishTarget[]
  onPublished?: () => void
}

export function PublishIssueDialog({
  open,
  onOpenChange,
  issue,
  targets,
  onPublished,
}: PublishIssueDialogProps) {
  const t = useTranslations("issues")
  const [targetId, setTargetId] = useState(targets[0]?.id ?? "")
  const [busy, setBusy] = useState(false)

  const target = targets.find((candidate) => candidate.id === targetId) ?? targets[0]

  function targetLabel(candidate: PublishTarget): string {
    return candidate.kind === "github"
      ? t("publish.target.github", { repository: candidate.repoFullName })
      : t("publish.target.binding", {
          provider: candidate.providerLabel,
          name: candidate.resourceName,
        })
  }

  async function submit() {
    if (!target || busy) return
    setBusy(true)
    try {
      const ref = await publishIssue(issue.id, target, { kind: "human" })
      toast.success(t("publish.success", { target: ref.label ?? targetLabel(target) }))
      onPublished?.()
      onOpenChange(false)
    } catch (cause) {
      toast.error(
        cause instanceof GithubWritebackError && cause.code !== "rejected"
          ? t(`writeback.error.${cause.code}`)
          : t("publish.failed", { reason: cause instanceof Error ? cause.message : String(cause) })
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="publish-issue-dialog">
        <DialogHeader>
          <DialogTitle>{t("publish.title")}</DialogTitle>
          <DialogDescription>{t("publish.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="publish-issue-target">{t("publish.targetLabel")}</Label>
            <Select value={target?.id ?? ""} onValueChange={setTargetId} disabled={busy}>
              <SelectTrigger id="publish-issue-target" data-testid="publish-issue-target">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {targets.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {targetLabel(candidate)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5 rounded-md border bg-muted/40 p-3 text-sm">
            <span className="text-xs font-medium text-muted-foreground">
              {t("publish.preview")}
            </span>
            <p className="font-medium" data-testid="publish-issue-preview-title">
              {issue.title}
            </p>
            {issue.description?.trim() ? (
              <p className="line-clamp-6 whitespace-pre-wrap text-muted-foreground">
                {issue.description}
              </p>
            ) : (
              <p className="text-muted-foreground">{t("publish.noDescription")}</p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("create.cancel")}
          </Button>
          <Button
            disabled={!target || busy}
            onClick={() => void submit()}
            data-testid="publish-issue-submit"
          >
            {t("publish.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
