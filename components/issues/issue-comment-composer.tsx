"use client"

/**
 * Comment box for the activity trail.
 *
 * The panel has always RENDERED comments — they are `issueEvents` rows of kind
 * `commented` — but `addIssueComment` had no caller anywhere in the app, so
 * there was no way to write one. A trail that shows other people's comments
 * and offers no way to reply is the clearest possible "built but dormant".
 *
 * Only local issues get one: a GitHub mirror's comment goes through the
 * write-back dialog instead, because it has to reach GitHub, and an agent
 * task has no comment concept at all.
 */

import { SendHorizontalIcon } from "lucide-react"
import { useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

export interface IssueCommentComposerProps {
  onSubmit: (body: string) => Promise<void> | void
  disabled?: boolean
}

export function IssueCommentComposer({ onSubmit, disabled }: IssueCommentComposerProps) {
  const t = useTranslations("issues")
  const [body, setBody] = useState("")
  const [busy, setBusy] = useState(false)

  const trimmed = body.trim()
  const canSend = trimmed.length > 0 && !busy && !disabled

  async function send() {
    if (!canSend) return
    setBusy(true)
    try {
      await onSubmit(trimmed)
      // Cleared only on success: a failed write must leave the text where the
      // user can retry it, and reporting the failure is the caller's job.
      setBody("")
    } catch {
      // Swallowed deliberately — see above. Re-throwing here would surface as
      // an unhandled rejection from the click handler and change nothing for
      // the user.
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="issue-comment-composer">
      <Textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          // Cmd/Ctrl+Enter sends; a bare Enter is a newline, because comments
          // routinely run to more than one line.
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void send()
          }
        }}
        rows={2}
        disabled={disabled || busy}
        placeholder={t("detail.commentPlaceholder")}
        aria-label={t("detail.comment")}
        className="min-h-16 text-sm"
        data-testid="issue-comment-input"
      />
      <Button
        size="sm"
        className="self-end"
        disabled={!canSend}
        onClick={() => void send()}
        data-testid="issue-comment-submit"
      >
        <SendHorizontalIcon className="size-3.5" />
        {t("detail.comment")}
      </Button>
    </div>
  )
}
