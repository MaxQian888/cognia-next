"use client"

/**
 * Confirmation for an irreversible external write.
 *
 * Every GitHub write-back lands here first. The dialog states the repo, the
 * issue number and the account the write goes out on, because "which of my two
 * connected accounts is about to comment on a public issue" is exactly the
 * thing a user cannot recover from getting wrong.
 *
 * The confirm button is the approval: `runGithubWriteback` parks the job in
 * `awaiting_approval` and only releases it when passed
 * `approval: "user-confirmed"`, which nothing but this component does.
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
import {
  GithubWritebackError,
  resolveGithubWritebackAccount,
  runGithubWriteback,
  type GithubWritebackAction,
  type GithubWritebackTarget,
} from "@/lib/issues/github-writeback"

export type GithubWritebackKind = GithubWritebackAction["kind"]

export interface GithubWritebackDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  kind: GithubWritebackKind
  target: GithubWritebackTarget
  /** Fired after GitHub accepted the write, so the caller can re-sync. */
  onCompleted?: () => void
}

export function GithubWritebackDialog({
  open,
  onOpenChange,
  kind,
  target,
  onCompleted,
}: GithubWritebackDialogProps) {
  const t = useTranslations("issues")

  const [body, setBody] = useState("")
  const [labels, setLabels] = useState("")
  const [reason, setReason] = useState<"completed" | "not_planned">("completed")
  const [accountLabel, setAccountLabel] = useState<string | null>(null)
  const [accountChecked, setAccountChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void resolveGithubWritebackAccount().then((account) => {
      if (cancelled) return
      setAccountLabel(account?.label ?? null)
      setAccountChecked(true)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  /**
   * Cleared on the way out rather than by an effect watching `open`: an effect
   * that calls setState is a cascading render, and routing every close path —
   * cancel, Escape, overlay click, a landed write — through `close()` keeps a
   * half-typed comment from reappearing the next time the dialog opens.
   */
  function close() {
    setBody("")
    setLabels("")
    setReason("completed")
    setError(null)
    setAccountChecked(false)
    onOpenChange(false)
  }

  const parsedLabels = labels
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean)

  const hasAccount = accountChecked && accountLabel !== null
  const inputReady =
    kind === "comment" ? body.trim().length > 0 : kind === "label" ? parsedLabels.length > 0 : true
  const canSubmit = hasAccount && inputReady && !busy

  function buildAction(): GithubWritebackAction {
    if (kind === "comment") return { kind: "comment", body: body.trim() }
    if (kind === "label") return { kind: "label", labels: parsedLabels }
    return { kind: "close", reason }
  }

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      await runGithubWriteback({
        target,
        action: buildAction(),
        approval: "user-confirmed",
      })
      toast.success(t("writeback.success"))
      onCompleted?.()
      close()
    } catch (cause) {
      // A known refusal gets a localized explanation with a fix in it; anything
      // else shows GitHub's own words rather than a generic failure.
      setError(
        cause instanceof GithubWritebackError && cause.code !== "rejected"
          ? t(`writeback.error.${cause.code}`)
          : cause instanceof Error
            ? cause.message
            : String(cause)
      )
    } finally {
      setBusy(false)
    }
  }

  const issueRef = `${target.repoFullName}#${target.number}`

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true)
        else close()
      }}
    >
      <DialogContent data-testid="github-writeback-dialog">
        <DialogHeader>
          <DialogTitle>{t(`writeback.title.${kind}`)}</DialogTitle>
          <DialogDescription>{t("writeback.description", { issue: issueRef })}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {kind === "comment" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="writeback-body">{t("writeback.bodyLabel")}</Label>
              <Textarea
                id="writeback-body"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                rows={4}
                data-testid="writeback-body"
              />
            </div>
          ) : null}

          {kind === "label" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="writeback-labels">{t("writeback.labelsLabel")}</Label>
              <Input
                id="writeback-labels"
                value={labels}
                onChange={(event) => setLabels(event.target.value)}
                placeholder={t("writeback.labelsPlaceholder")}
                data-testid="writeback-labels"
              />
              <p className="text-xs text-muted-foreground">{t("writeback.labelsHint")}</p>
            </div>
          ) : null}

          {kind === "close" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="writeback-reason">{t("writeback.reasonLabel")}</Label>
              <Select
                value={reason}
                onValueChange={(value) => setReason(value as "completed" | "not_planned")}
              >
                <SelectTrigger id="writeback-reason" data-testid="writeback-reason">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="completed">{t("writeback.reason.completed")}</SelectItem>
                  <SelectItem value="not_planned">{t("writeback.reason.not_planned")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <p
            className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
            data-testid="writeback-account"
          >
            {!accountChecked
              ? t("writeback.accountChecking")
              : hasAccount
                ? t("writeback.account", { account: accountLabel ?? "" })
                : t("writeback.error.no-account")}
          </p>

          {error ? (
            <p className="text-sm text-destructive" data-testid="writeback-error">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t("create.cancel")}
          </Button>
          <Button
            variant={kind === "close" ? "destructive" : "default"}
            onClick={confirm}
            disabled={!canSubmit}
            data-testid="writeback-confirm"
          >
            {t(`writeback.confirm.${kind}`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
