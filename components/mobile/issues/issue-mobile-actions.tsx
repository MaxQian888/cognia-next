"use client"

/**
 * The phone's writes on one issue (spec 2026-09-06 D8): accepting it out of
 * triage (or sending it back), status, assignee, a sub-issue's stage and a
 * comment. Each one is a queued `issue_apply_action` job, not a local write.
 * The row on screen keeps showing what the host last said until the next pull
 * brings the host's answer back, so a refused move never looks applied here.
 *
 * Only a local issue has a write path. A row federated in from GitHub or an
 * agent board is edited in that system, so the block stays off for it and the
 * read-only badge stays on.
 */

import { SendHorizontalIcon } from "lucide-react"
import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { AssigneePicker } from "@/components/issues/assignee-picker"
import { IssueTriageRow } from "@/components/issues/triage/issue-triage-row"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import {
  isRemoteIssueAction,
  queueIssueAction,
  type RemoteIssueAction,
} from "@/lib/issues/remote-write"
import { ISSUE_STAGE_MAX, ISSUE_STATUSES, isIssueStage, type IssueStatus } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"

export interface IssueMobileActionsProps {
  item: UnifiedIssueItem
}

export function IssueMobileActions({ item }: IssueMobileActionsProps) {
  const t = useTranslations("issues")
  const [comment, setComment] = useState("")
  // The stage box commits on blur or Enter, not per keystroke: each commit is
  // a queued job, and "1" on the way to "12" is not an edit.
  const [stageDraft, setStageDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState<RemoteIssueAction["kind"] | null>(null)

  async function queue(action: RemoteIssueAction) {
    setBusy(action.kind)
    try {
      await queueIssueAction({ issueId: item.sourceId, identifier: item.identifier, action })
      toast.success(t("mobile.queued", { identifier: item.identifier }))
      return true
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setBusy(null)
    }
  }

  function commitStage() {
    if (stageDraft === null) return
    const raw = stageDraft.trim()
    setStageDraft(null)
    const to = raw === "" ? null : Number(raw)
    if (to !== null && !isIssueStage(to)) return
    if ((to ?? undefined) !== item.stage) void queue({ kind: "stage", to })
  }

  return (
    <div className="flex flex-col gap-3 border-t pt-3" data-testid="issues-mobile-actions">
      <p className="text-xs text-muted-foreground">{t("mobile.queuedHint")}</p>

      <IssueTriageRow
        item={item}
        onAction={
          busy === null
            ? (action) => {
                if (isRemoteIssueAction(action)) void queue(action)
              }
            : undefined
        }
      />

      {item.capabilities.canMove ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor="issue-mobile-status">{t("detail.status")}</Label>
          <NativeSelect
            id="issue-mobile-status"
            value={item.status}
            disabled={busy !== null}
            onChange={(event) => {
              const to = event.target.value as IssueStatus
              if (to !== item.status) void queue({ kind: "status", to })
            }}
            data-testid="issues-mobile-status"
          >
            {ISSUE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`status.${status}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : null}

      {item.capabilities.canAssign ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor="issue-mobile-assignee">{t("detail.assignee")}</Label>
          <AssigneePicker
            id="issue-mobile-assignee"
            value={item.assignee ?? null}
            disabled={busy !== null}
            onChange={(actor) => void queue({ kind: "assignee", to: actor })}
            data-testid="issues-mobile-assignee"
          />
        </div>
      ) : null}

      {item.parentId && item.capabilities.canEdit ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor="issue-mobile-stage">{t("planning.stage")}</Label>
          <Input
            id="issue-mobile-stage"
            type="number"
            min={1}
            max={ISSUE_STAGE_MAX}
            step={1}
            inputMode="numeric"
            value={stageDraft ?? (item.stage === undefined ? "" : String(item.stage))}
            placeholder={t("planning.noStage")}
            disabled={busy !== null}
            onChange={(event) => setStageDraft(event.target.value)}
            onBlur={commitStage}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitStage()
            }}
            data-testid="issues-mobile-stage"
          />
          <p className="text-xs text-muted-foreground">{t("planning.stageHint")}</p>
        </div>
      ) : null}

      {item.capabilities.canComment ? (
        <form
          className="flex flex-col gap-1"
          onSubmit={(event) => {
            event.preventDefault()
            const body = comment.trim()
            if (!body) return
            void queue({ kind: "comment", body }).then((ok) => {
              if (ok) setComment("")
            })
          }}
        >
          <Label htmlFor="issue-mobile-comment">{t("detail.comment")}</Label>
          <Textarea
            id="issue-mobile-comment"
            value={comment}
            rows={2}
            placeholder={t("detail.commentPlaceholder")}
            disabled={busy !== null}
            onChange={(event) => setComment(event.target.value)}
            data-testid="issues-mobile-comment"
          />
          <Button
            type="submit"
            size="sm"
            className="self-end"
            disabled={busy !== null || !comment.trim()}
            data-testid="issues-mobile-comment-send"
          >
            <SendHorizontalIcon className="size-4" />
            {t("mobile.sendComment")}
          </Button>
        </form>
      ) : null}
    </div>
  )
}
