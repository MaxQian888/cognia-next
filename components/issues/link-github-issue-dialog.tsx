"use client"

/**
 * Bind a local issue to an existing GitHub issue.
 *
 * `linkIssueToGithub` had no caller anywhere in the app, which left the whole
 * `github-loop` run adapter unreachable for any issue not created through the
 * GitHub sync: the adapter refuses with `no-github-ref`, and nothing could
 * ever set one.
 *
 * The repo is CHOSEN, not typed. A container's bound `github-repo` resources
 * are the only repos this workspace can act on — free text would let someone
 * link to a repository the loop adapter would then refuse.
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { linkIssueToGithub } from "@/lib/db/issues"

export interface LinkGithubIssueDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Local issue id. */
  issueId: string
  /** Repos bound to this issue's container — the only legal targets. */
  repos: readonly string[]
  onLinked?: () => void
}

export function LinkGithubIssueDialog({
  open,
  onOpenChange,
  issueId,
  repos,
  onLinked,
}: LinkGithubIssueDialogProps) {
  const t = useTranslations("issues")
  const [repo, setRepo] = useState(repos[0] ?? "")
  const [number, setNumber] = useState("")
  const [busy, setBusy] = useState(false)

  const selectedRepo = repo || (repos[0] ?? "")
  const parsed = Number.parseInt(number, 10)
  const canSubmit = Boolean(selectedRepo) && Number.isInteger(parsed) && parsed > 0 && !busy

  async function submit() {
    if (!canSubmit) return
    setBusy(true)
    try {
      await linkIssueToGithub(
        issueId,
        {
          repoFullName: selectedRepo,
          number: parsed,
          // Derived, not asked for: GitHub's issue URL is a pure function of
          // the repo and the number, and asking would invite a mismatch.
          htmlUrl: `https://github.com/${selectedRepo}/issues/${parsed}`,
        },
        { kind: "human" }
      )
      setNumber("")
      onLinked?.()
      onOpenChange(false)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="link-github-issue-dialog">
        <DialogHeader>
          <DialogTitle>{t("writeback.linkTitle")}</DialogTitle>
          <DialogDescription>{t("writeback.linkHint")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="link-github-repo">{t("writeback.linkRepo")}</Label>
            <Select value={selectedRepo} onValueChange={setRepo} disabled={busy}>
              <SelectTrigger id="link-github-repo" data-testid="link-github-repo">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {repos.map((candidate) => (
                  <SelectItem key={candidate} value={candidate}>
                    {candidate}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="link-github-number">{t("writeback.linkNumber")}</Label>
            <Input
              id="link-github-number"
              value={number}
              inputMode="numeric"
              disabled={busy}
              onChange={(event) => setNumber(event.target.value.replace(/[^\d]/g, ""))}
              placeholder="123"
              className="w-32"
              data-testid="link-github-number"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("create.cancel")}
          </Button>
          <Button
            disabled={!canSubmit}
            onClick={() => void submit()}
            data-testid="link-github-submit"
          >
            {t("writeback.linkSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
