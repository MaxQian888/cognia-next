"use client"

/**
 * CommentPanel - Comments and annotations UI for Canvas documents
 */

import { useState, useCallback, useMemo, useEffect } from "react"
import { useTranslations } from "next-intl"
import {
  MessageSquare,
  Plus,
  Reply,
  Trash2,
  Check,
  X,
  CheckCircle,
  Circle,
  SmilePlus,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { cn } from "@/lib/utils"
import { useCommentStore } from "@/stores/canvas/comment-store"
import { formatRelativeDate } from "@/lib/canvas/utils"
import { REACTION_EMOJIS } from "@/lib/canvas/constants"
import type { CanvasComment, LineRange } from "@/types/canvas/collaboration"

interface CommentPanelProps {
  documentId: string
  currentUserId?: string
  currentUserName?: string
  selectedRange?: LineRange
  trigger?: React.ReactNode
}

export function CommentPanel({
  documentId,
  currentUserId = "user-1",
  currentUserName = "You",
  selectedRange,
  trigger,
}: CommentPanelProps) {
  const t = useTranslations("canvas")
  const [open, setOpen] = useState(false)
  const [newComment, setNewComment] = useState("")
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const [replyContent, setReplyContent] = useState("")
  const [showResolved, setShowResolved] = useState(false)

  const {
    addComment,
    deleteComment,
    resolveComment,
    unresolveComment,
    addReaction,
    removeReaction,
    replyToComment,
    getCommentsForDocument,
    getUnresolvedComments,
    loadCommentsForDocument,
  } = useCommentStore()

  useEffect(() => {
    void loadCommentsForDocument(documentId)
  }, [documentId, loadCommentsForDocument])

  const allComments = getCommentsForDocument(documentId)
  const unresolvedComments = getUnresolvedComments(documentId)

  const displayedComments = useMemo(() => {
    const rootComments = allComments.filter((c) => !c.parentId)
    if (showResolved) {
      return rootComments
    }
    return rootComments.filter((c) => !c.resolvedAt)
  }, [allComments, showResolved])

  const getReplies = useCallback(
    (commentId: string) => allComments.filter((c) => c.parentId === commentId),
    [allComments]
  )

  const handleAddComment = useCallback(() => {
    if (!newComment.trim() || !selectedRange) return

    addComment(documentId, {
      documentId,
      content: newComment.trim(),
      authorId: currentUserId,
      authorName: currentUserName,
      range: selectedRange,
    })
    setNewComment("")
  }, [addComment, documentId, newComment, currentUserId, currentUserName, selectedRange])

  const handleReply = useCallback(
    (parentId: string) => {
      if (!replyContent.trim()) return

      replyToComment(documentId, parentId, {
        documentId,
        content: replyContent.trim(),
        authorId: currentUserId,
        authorName: currentUserName,
      })
      setReplyContent("")
      setReplyingTo(null)
    },
    [replyToComment, documentId, replyContent, currentUserId, currentUserName]
  )

  const handleToggleReaction = useCallback(
    (commentId: string, emoji: string) => {
      const comment = allComments.find((c) => c.id === commentId)
      const reaction = comment?.reactions.find((r) => r.emoji === emoji)
      const hasReacted = reaction?.users.includes(currentUserId)

      if (hasReacted) {
        removeReaction(documentId, commentId, emoji, currentUserId)
      } else {
        addReaction(documentId, commentId, emoji, currentUserId)
      }
    },
    [allComments, addReaction, removeReaction, documentId, currentUserId]
  )

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        {trigger || (
          <Button variant="ghost" size="sm" className="gap-2">
            <MessageSquare className="h-4 w-4" />
            <span className="hidden sm:inline">{t("comments")}</span>
            {unresolvedComments.length > 0 && (
              <Badge variant="secondary" className="ml-1 px-1.5 py-0">
                {unresolvedComments.length}
              </Badge>
            )}
          </Button>
        )}
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:w-[400px]">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5" />
            {t("comments")}
          </SheetTitle>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {/* Add Comment */}
          <div className="space-y-2">
            <Textarea
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              placeholder={t("addComment")}
              className="min-h-[80px] resize-none"
            />
            <div className="flex items-center justify-between">
              {selectedRange && (
                <Badge variant="outline" className="text-xs">
                  {t("lines")} {selectedRange.startLine}-{selectedRange.endLine}
                </Badge>
              )}
              <Button
                size="sm"
                onClick={handleAddComment}
                disabled={!newComment.trim()}
                className="ml-auto"
              >
                <Plus className="h-4 w-4 mr-1" />
                {t("addComment")}
              </Button>
            </div>
          </div>

          <Separator />

          {/* Filter */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              {displayedComments.length} {t("comments")}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowResolved(!showResolved)}
              className="text-xs"
            >
              {showResolved ? t("hideResolved") : t("showResolved")}
            </Button>
          </div>

          {/* Comments List */}
          <ScrollArea className="h-[calc(100vh-320px)]">
            <div className="space-y-3 pr-4">
              {displayedComments.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t("noComments")}</p>
              ) : (
                displayedComments.map((comment) => (
                  <CommentThread
                    key={comment.id}
                    comment={comment}
                    replies={getReplies(comment.id)}
                    currentUserId={currentUserId}
                    isReplying={replyingTo === comment.id}
                    replyContent={replyContent}
                    onReplyContentChange={setReplyContent}
                    onStartReply={() => setReplyingTo(comment.id)}
                    onCancelReply={() => {
                      setReplyingTo(null)
                      setReplyContent("")
                    }}
                    onSubmitReply={() => handleReply(comment.id)}
                    onDelete={(id) => deleteComment(documentId, id)}
                    onResolve={(id) => resolveComment(documentId, id)}
                    onUnresolve={(id) => unresolveComment(documentId, id)}
                    onToggleReaction={handleToggleReaction}
                    t={t}
                  />
                ))
              )}
            </div>
          </ScrollArea>
        </div>
      </SheetContent>
    </Sheet>
  )
}

interface CommentThreadProps {
  comment: CanvasComment
  replies: CanvasComment[]
  currentUserId: string
  isReplying: boolean
  replyContent: string
  onReplyContentChange: (content: string) => void
  onStartReply: () => void
  onCancelReply: () => void
  onSubmitReply: () => void
  onDelete: (id: string) => void
  onResolve: (id: string) => void
  onUnresolve: (id: string) => void
  onToggleReaction: (commentId: string, emoji: string) => void
  t: ReturnType<typeof useTranslations>
}

function CommentThread({
  comment,
  replies,
  currentUserId,
  isReplying,
  replyContent,
  onReplyContentChange,
  onStartReply,
  onCancelReply,
  onSubmitReply,
  onDelete,
  onResolve,
  onUnresolve,
  onToggleReaction,
  t,
}: CommentThreadProps) {
  const isResolved = !!comment.resolvedAt
  const isAuthor = comment.authorId === currentUserId

  const initials = comment.authorName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2)

  return (
    <div className={cn("rounded-lg border p-3 space-y-2", isResolved && "opacity-60")}>
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <Avatar className="h-6 w-6">
            <AvatarFallback className="text-xs">{initials}</AvatarFallback>
          </Avatar>
          <div>
            <span className="text-sm font-medium">{comment.authorName}</span>
            <span className="text-xs text-muted-foreground ml-2">
              {formatRelativeDate(comment.createdAt, t)}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {comment.range && (
            <Badge variant="outline" className="text-[10px]">
              L{comment.range.startLine}
            </Badge>
          )}
          {isResolved ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => onUnresolve(comment.id)}
                >
                  <CheckCircle className="h-3.5 w-3.5 text-green-500" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("unresolve")}</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => onResolve(comment.id)}
                >
                  <Circle className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("resolve")}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Content */}
      <p className="text-sm whitespace-pre-wrap">{comment.content}</p>

      {/* Actions */}
      <div className="flex items-center gap-1 pt-1">
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onStartReply}>
          <Reply className="h-3 w-3 mr-1" />
          {t("reply")}
        </Button>

        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
              <SmilePlus className="h-3 w-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-2">
            <div className="flex gap-1">
              {REACTION_EMOJIS.map((emoji) => (
                <Button
                  key={emoji}
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 text-lg"
                  onClick={() => onToggleReaction(comment.id, emoji)}
                >
                  {emoji}
                </Button>
              ))}
            </div>
          </PopoverContent>
        </Popover>

        {isAuthor && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-destructive hover:text-destructive ml-auto"
            onClick={() => onDelete(comment.id)}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        )}
      </div>

      {/* Reactions */}
      {comment.reactions.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {comment.reactions.map((reaction) => (
            <Button
              key={reaction.emoji}
              variant="outline"
              size="sm"
              className={cn(
                "h-6 px-2 text-xs",
                reaction.users.includes(currentUserId) && "bg-primary/10"
              )}
              onClick={() => onToggleReaction(comment.id, reaction.emoji)}
            >
              {reaction.emoji} {reaction.users.length}
            </Button>
          ))}
        </div>
      )}

      {/* Reply Form */}
      {isReplying && (
        <div className="pt-2 space-y-2">
          <Textarea
            value={replyContent}
            onChange={(e) => onReplyContentChange(e.target.value)}
            placeholder={t("writeReply")}
            className="min-h-[60px] resize-none text-sm"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onCancelReply}>
              <X className="h-3 w-3 mr-1" />
              {t("cancel")}
            </Button>
            <Button size="sm" onClick={onSubmitReply} disabled={!replyContent.trim()}>
              <Check className="h-3 w-3 mr-1" />
              {t("reply")}
            </Button>
          </div>
        </div>
      )}

      {/* Replies */}
      {replies.length > 0 && (
        <div className="pl-4 border-l-2 border-muted space-y-2 mt-2">
          {replies.map((reply) => (
            <ReplyItem
              key={reply.id}
              reply={reply}
              currentUserId={currentUserId}
              onDelete={onDelete}
              onToggleReaction={onToggleReaction}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface ReplyItemProps {
  reply: CanvasComment
  currentUserId: string
  onDelete: (id: string) => void
  onToggleReaction: (commentId: string, emoji: string) => void
  t: ReturnType<typeof useTranslations>
}

function ReplyItem({ reply, currentUserId, onDelete, onToggleReaction, t }: ReplyItemProps) {
  const isAuthor = reply.authorId === currentUserId
  const initials = reply.authorName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2)

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Avatar className="h-5 w-5">
          <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
        </Avatar>
        <span className="text-xs font-medium">{reply.authorName}</span>
        <span className="text-[10px] text-muted-foreground">
          {formatRelativeDate(reply.createdAt, t)}
        </span>
        {isAuthor && (
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 ml-auto text-destructive hover:text-destructive"
            onClick={() => onDelete(reply.id)}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        )}
      </div>
      <p className="text-xs whitespace-pre-wrap pl-7">{reply.content}</p>

      {reply.reactions.length > 0 && (
        <div className="flex flex-wrap gap-1 pl-7">
          {reply.reactions.map((reaction) => (
            <Button
              key={reaction.emoji}
              variant="outline"
              size="sm"
              className={cn(
                "h-5 px-1.5 text-[10px]",
                reaction.users.includes(currentUserId) && "bg-primary/10"
              )}
              onClick={() => onToggleReaction(reply.id, reaction.emoji)}
            >
              {reaction.emoji} {reaction.users.length}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

export default CommentPanel
