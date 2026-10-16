"use client"

import { useEffect, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  CheckIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  PencilIcon,
  ReplyIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import { useChatStore } from "@/stores/chat"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import {
  addContextComment,
  addContextCommentReaction,
  deleteContextComment,
  listContextCommentsForResource,
  removeContextCommentReaction,
  reopenContextComment,
  replyToContextComment,
  resolveContextComment,
  updateContextComment,
} from "@/lib/db/context-comments"
import { REACTION_EMOJIS } from "@/lib/canvas/constants"
import type {
  ContextComment,
  ContextCommentAnchor,
  ContextCommentResourceRef,
} from "@/types/context-comment"
import { isContextCommentAnchorStale } from "@/types/context-comment"
import type { ProjectFileAnchorResolution } from "@/lib/context-workbench/project-file-comment-anchors"
import { commentAnchorLabel } from "@/lib/artifacts/format-selection-context"

export interface ContextCommentsPanelProps {
  resource: ContextCommentResourceRef
  revision: string
  anchor?: ContextCommentAnchor
  currentUserId?: string
  currentUserName?: string
  /**
   * What the commented-on thing is called, for the chat context chip a comment
   * can be handed to. Falls back to the resource id, which is at least stable —
   * hosts that know a human title should pass it.
   */
  resourceTitle?: string
  /**
   * Bring an anchor up to date before it is shown.
   *
   * The panel is resource-agnostic, so it cannot know how to move an anchor
   * itself. A Canvas document with a live shared document passes one backed by
   * its CRDT, and the comment's line range follows the text instead of naming
   * where it used to be. Project files can return an asynchronous resolution
   * with a moved/orphaned state. Other hosts display the stored anchor as written.
   */
  resolveAnchor?: (
    anchor: ContextCommentAnchor,
    commentId?: string
  ) => ContextCommentAnchor | ProjectFileAnchorResolution | Promise<ProjectFileAnchorResolution>
  /** Capture the exact current buffer before an asynchronous comment write. */
  createAnchor?: () => Promise<ContextCommentAnchor>
  onRevealAnchor?: (anchor: ContextCommentAnchor) => void
}

export function ContextCommentsPanel({
  resource,
  revision,
  anchor = { kind: "resource", revision },
  currentUserId = "local-user",
  currentUserName,
  resourceTitle,
  resolveAnchor,
  createAnchor,
  onRevealAnchor,
}: ContextCommentsPanelProps) {
  const t = useTranslations("contextWorkbench.commentsPanel")
  const authorName = currentUserName ?? t("you")
  const addContextSelection = useChatStore((state) => state.addContextSelection)
  const storedComments = useLiveQuery(
    () => listContextCommentsForResource(resource.kind, resource.id),
    [resource.kind, resource.id],
    []
  )
  // Keep synchronous Canvas resolution synchronous and authoritative. Project
  // hashes resolve asynchronously; obsolete completions cannot replace a newer view.
  const pending = useMemo(
    () =>
      storedComments.map((comment) => ({
        comment,
        result: resolveAnchor?.(comment.anchor, comment.id) ?? comment.anchor,
      })),
    [storedComments, resolveAnchor]
  )
  const [completed, setCompleted] = useState<{
    source: typeof pending
    results: Map<string, ProjectFileAnchorResolution | null>
  } | null>(null)
  useEffect(() => {
    let cancelled = false
    const asynchronous = pending.flatMap(({ comment, result }) =>
      result instanceof Promise ? [{ comment, result }] : []
    )
    if (asynchronous.length) {
      void Promise.all(
        asynchronous.map(async ({ comment, result }) => {
          try {
            return [comment.id, await result] as const
          } catch {
            return [comment.id, null] as const
          }
        })
      ).then((results) => {
        if (!cancelled) setCompleted({ source: pending, results: new Map(results) })
      })
    }
    return () => {
      cancelled = true
    }
  }, [pending])
  const comments = useMemo(
    () =>
      pending.map(({ comment, result }) => {
        const resolved =
          result instanceof Promise
            ? completed?.source === pending
              ? completed.results.get(comment.id)
              : undefined
            : result
        if (resolved && "kind" in resolved) return { ...comment, anchor: resolved }
        const resolution = resolved ?? undefined
        return {
          ...comment,
          resolution,
          resolutionError: resolved === null,
          anchor:
            resolution?.start !== undefined &&
            resolution.end !== undefined &&
            comment.anchor.kind === "text-range"
              ? {
                  ...comment.anchor,
                  start: resolution.start,
                  end: resolution.end,
                  lineRange: resolution.lineRange,
                }
              : comment.anchor,
        }
      }),
    [pending, completed]
  )
  const [draft, setDraft] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(false)
  const [showResolved, setShowResolved] = useState(false)
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const [replyDraft, setReplyDraft] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState("")

  const roots = useMemo(
    () =>
      comments.filter(
        (comment) => !comment.parentId && (showResolved || comment.resolvedAt === undefined)
      ),
    [comments, showResolved]
  )
  const repliesByParent = useMemo(() => {
    const grouped = new Map<string, (typeof comments)[number][]>()
    for (const comment of comments) {
      if (!comment.parentId) continue
      grouped.set(comment.parentId, [...(grouped.get(comment.parentId) ?? []), comment])
    }
    return grouped
  }, [comments])

  const submitComment = async () => {
    const content = draft.trim()
    if (!content || submitting) return
    setSubmitting(true)
    setSubmitError(false)
    try {
      const capturedAnchor = createAnchor ? await createAnchor() : { ...anchor, revision }
      await addContextComment({
        resource,
        anchor: capturedAnchor,
        authorId: currentUserId,
        authorName,
        content,
      })
      setDraft((current) => (current === draft ? "" : current))
    } catch {
      setSubmitError(true)
    } finally {
      setSubmitting(false)
    }
  }

  const submitReply = async (parentId: string) => {
    const content = replyDraft.trim()
    if (!content) return
    await replyToContextComment(parentId, {
      authorId: currentUserId,
      authorName,
      content,
    })
    setReplyDraft("")
    setReplyingTo(null)
  }

  const submitEdit = async (commentId: string) => {
    const content = editDraft.trim()
    if (!content) return
    await updateContextComment(commentId, content)
    setEditingId(null)
    setEditDraft("")
  }

  const toggleReaction = async (comment: ContextComment, emoji: string) => {
    const reacted = comment.reactions.some(
      (reaction) => reaction.emoji === emoji && reaction.users.includes(currentUserId)
    )
    if (reacted) await removeContextCommentReaction(comment.id, emoji, currentUserId)
    else await addContextCommentReaction(comment.id, emoji, currentUserId)
  }

  const renderComment = (comment: (typeof comments)[number], reply = false) => {
    const resolution = "resolution" in comment ? comment.resolution : undefined
    const resolutionError = "resolutionError" in comment && comment.resolutionError
    const stale = resolution
      ? resolution.status === "legacy-stale"
      : isContextCommentAnchorStale(comment, revision)
    const orphaned = resolution?.status === "orphaned"
    const location = comment.anchor.kind === "text-range" ? comment.anchor.lineRange : undefined
    const canReveal =
      !stale &&
      !orphaned &&
      !resolutionError &&
      location &&
      (resolution?.status === "resolved" || resolution?.status === "moved")
    const isAuthor = comment.authorId === currentUserId
    const editing = editingId === comment.id
    return (
      <article
        key={comment.id}
        className={reply ? "ml-5 rounded-md border bg-muted/20 p-2" : "rounded-md border p-3"}
      >
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{comment.authorName}</span>
          {stale ? <Badge variant="outline">{t("stale")}</Badge> : null}
          {comment.resolvedAt ? <Badge variant="secondary">{t("resolved")}</Badge> : null}
        </div>
        {resolutionError ? (
          <p className="mt-2 text-xs text-muted-foreground">{t("anchorUnavailable")}</p>
        ) : null}
        {orphaned ? (
          <div className="mt-2 space-y-1 text-sm">
            <p className="text-muted-foreground">{t("anchorRemoved")}</p>
            {comment.anchor.kind === "text-range" && comment.anchor.quotedText !== undefined ? (
              <blockquote className="max-h-32 overflow-auto whitespace-pre-wrap border-l-2 pl-2">
                {comment.anchor.quotedText}
              </blockquote>
            ) : null}
          </div>
        ) : null}
        {canReveal ? (
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            {resolution?.status === "moved" ? <span>{t("anchorMoved")}</span> : null}
            <button
              type="button"
              className="hover:underline"
              disabled={!onRevealAnchor}
              onClick={() => onRevealAnchor?.(comment.anchor)}
            >
              {t("anchorLocation", { start: location.startLine, end: location.endLine })}
            </button>
          </div>
        ) : null}
        {editing ? (
          <div className="mt-2 space-y-2">
            <Textarea value={editDraft} onChange={(event) => setEditDraft(event.target.value)} />
            <div className="flex gap-1">
              <Button size="sm" onClick={() => void submitEdit(comment.id)}>
                <CheckIcon className="size-3.5" />
                {t("save")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                <XIcon className="size-3.5" />
                {t("cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <p className="mt-2 whitespace-pre-wrap text-sm">{comment.content}</p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {REACTION_EMOJIS.map((emoji) => {
            const reaction = comment.reactions.find((candidate) => candidate.emoji === emoji)
            return (
              <Button
                key={emoji}
                type="button"
                size="xs"
                variant={reaction?.users.includes(currentUserId) ? "secondary" : "ghost"}
                aria-label={t("toggleReaction", { emoji })}
                onClick={() => void toggleReaction(comment, emoji)}
              >
                {emoji}
                {reaction ? <span>{reaction.users.length}</span> : null}
              </Button>
            )
          })}
          {!reply ? (
            <Button size="xs" variant="ghost" onClick={() => setReplyingTo(comment.id)}>
              <ReplyIcon className="size-3.5" />
              {t("reply")}
            </Button>
          ) : null}
          {!reply ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                void (comment.resolvedAt
                  ? reopenContextComment(comment.id)
                  : resolveContextComment(comment.id, currentUserId))
              }
            >
              <CheckIcon className="size-3.5" />
              {comment.resolvedAt ? t("reopen") : t("resolve")}
            </Button>
          ) : null}
          {isAuthor ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setEditingId(comment.id)
                setEditDraft(comment.content)
              }}
            >
              <PencilIcon className="size-3.5" />
              {t("edit")}
            </Button>
          ) : null}
          {isAuthor ? (
            <Button size="xs" variant="ghost" onClick={() => void deleteContextComment(comment.id)}>
              <Trash2Icon className="size-3.5" />
              {t("delete")}
            </Button>
          ) : null}
          {/* The panel had no route back to the conversation at all: a user
              could write down exactly what was wrong and the assistant would
              never see a word of it. Rides the same staging pipeline as an
              artifact selection, so it lands as a chip the composer folds in. */}
          <Button
            size="xs"
            variant="ghost"
            data-testid="context-comment-to-chat"
            aria-label={t("sendToChatAria", { author: comment.authorName })}
            onClick={() =>
              addContextSelection({
                kind: "comment",
                title: resourceTitle ?? resource.id,
                snapshot: comment.content,
                comment: "",
                anchorLabel: commentAnchorLabel(comment.anchor),
              })
            }
          >
            <MessageSquarePlusIcon className="size-3.5" />
            {t("sendToChat")}
          </Button>
        </div>
      </article>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b p-3">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t("placeholder")}
          aria-label={t("placeholder")}
        />
        <div className="flex items-center justify-between gap-2">
          <Button size="sm" variant="ghost" onClick={() => setShowResolved((value) => !value)}>
            {showResolved ? t("hideResolved") : t("showResolved")}
          </Button>
          <Button
            size="sm"
            disabled={!draft.trim() || submitting}
            onClick={() => void submitComment()}
          >
            <MessageSquareIcon className="size-4" />
            {t("add")}
          </Button>
        </div>
      </div>
      {submitError ? (
        <p role="alert" className="px-3 text-sm text-destructive">
          {t("commentSaveFailed")}
        </p>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-3">
          {roots.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            roots.map((root) => (
              <div key={root.id} className="space-y-2">
                {renderComment(root)}
                {(repliesByParent.get(root.id) ?? []).map((reply) => renderComment(reply, true))}
                {replyingTo === root.id ? (
                  <div className="ml-5 space-y-2">
                    <Textarea
                      value={replyDraft}
                      onChange={(event) => setReplyDraft(event.target.value)}
                      placeholder={t("replyPlaceholder")}
                      aria-label={t("replyPlaceholder")}
                    />
                    <div className="flex gap-1">
                      <Button size="sm" onClick={() => void submitReply(root.id)}>
                        {t("reply")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setReplyingTo(null)}>
                        {t("cancel")}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
