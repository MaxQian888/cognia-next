"use client"

/**
 * Task comment thread — the durable, board-visible delivery channel for an agent team.
 * Teammates record findings/decisions/results on a task via the `task_add_comment`
 * built-in; the operator reads them here and can add their own. Ported in spirit from the
 * external agent-teams app's task protocol (task comments as the primary delivery channel).
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { FileTextIcon, LinkIcon, SendIcon, SparklesIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { useCopy } from "@/hooks/ui/use-copy"
import type { AgentTaskComment, TaskCommentAttachment } from "@/types/agent/agent-team"
import { senderColor } from "./sender-color"

/** Operator-authored comments use this synthetic author id. */
export const TASK_COMMENT_OPERATOR_ID = "user"

function formatCommentTime(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function AttachmentChip({ attachment }: { attachment: TaskCommentAttachment }) {
  const t = useTranslations("agentTeamsWorkspace.tasks.comments")
  const { copy } = useCopy()
  const Icon =
    attachment.kind === "link"
      ? LinkIcon
      : attachment.kind === "artifact"
        ? SparklesIcon
        : FileTextIcon

  if (attachment.kind === "link") {
    return (
      <a
        href={attachment.ref}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex max-w-full items-center gap-1 rounded border bg-muted px-1.5 py-0.5 text-[10px] hover:bg-accent"
        data-testid="task-comment-attachment"
      >
        <Icon className="size-3 shrink-0" />
        <span className="truncate">{attachment.name}</span>
      </a>
    )
  }

  return (
    <button
      type="button"
      onClick={async () => {
        const ok = await copy(attachment.ref)
        if (ok) toast.success(t("refCopied"))
      }}
      title={attachment.ref}
      className="inline-flex max-w-full items-center gap-1 rounded border bg-muted px-1.5 py-0.5 text-[10px] hover:bg-accent"
      data-testid="task-comment-attachment"
    >
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{attachment.name}</span>
    </button>
  )
}

function CommentRow({ comment }: { comment: AgentTaskComment }) {
  return (
    <div className="flex gap-2" data-testid={`task-comment-${comment.id}`}>
      <span
        className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white"
        style={{ backgroundColor: senderColor(comment.authorName) }}
        aria-hidden
      >
        {comment.authorName.slice(0, 1).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] font-medium">{comment.authorName}</span>
          <span className="text-[10px] text-muted-foreground">
            {formatCommentTime(comment.createdAt)}
          </span>
        </div>
        <div className="mt-0.5 text-xs leading-relaxed">
          <MarkdownRenderer content={comment.text} messageId={comment.id} />
        </div>
        {comment.attachments && comment.attachments.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {comment.attachments.map((a) => (
              <AttachmentChip key={a.id} attachment={a} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export interface TaskCommentsProps {
  taskId: string
}

export function TaskComments({ taskId }: TaskCommentsProps) {
  const t = useTranslations("agentTeamsWorkspace.tasks.comments")
  const task = useAgentTeamStore((s) => s.tasks[taskId])
  const addTaskComment = useAgentTeamStore((s) => s.addTaskComment)
  const [text, setText] = useState("")

  const comments = task?.comments ?? []

  const handleSubmit = () => {
    const body = text.trim()
    if (!body) return
    const created = addTaskComment({ taskId, authorId: TASK_COMMENT_OPERATOR_ID, text: body })
    if (created) {
      setText("")
      toast.success(t("added"))
    }
  }

  return (
    <div className="mt-2 space-y-3 border-t pt-2" data-testid="task-comments">
      {comments.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="space-y-3">
          {comments.map((c) => (
            <CommentRow key={c.id} comment={c} />
          ))}
        </div>
      )}

      <div className="space-y-1">
        <Textarea
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("placeholder")}
          aria-label={t("placeholder")}
          className="text-xs"
          data-testid="task-comment-input"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault()
              handleSubmit()
            }
          }}
        />
        <div className="flex justify-end">
          <Button size="sm" onClick={handleSubmit} disabled={!text.trim()}>
            <SendIcon className="mr-1.5 size-3" />
            {t("add")}
          </Button>
        </div>
      </div>
    </div>
  )
}
