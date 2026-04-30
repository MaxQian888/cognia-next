"use client"

import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message"
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning"
import { Task, TaskContent, TaskItem, TaskTrigger } from "@/components/ai-elements/task"
import { Tool, ToolBody, ToolHeader, ToolContent } from "@/components/ai-elements/tool"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  BookmarkIcon,
  CheckCircle2Icon,
  CheckIcon,
  CircleIcon,
  ClockIcon,
  CopyIcon,
  PencilIcon,
  RefreshCcwIcon,
  Share2Icon,
} from "lucide-react"
import type { ToolUIPart, UIMessage } from "ai"
import type { UsageInfo } from "@/lib/claude/adapter"
import type { Character } from "@/lib/claude/types"
import { useCallback, useMemo, useState, type KeyboardEvent } from "react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { avatarColor, avatarGlyph } from "@/lib/ui/avatar"
import { useChatStore } from "@/stores/chat"
import { useCopy } from "@/hooks/ui/use-copy"
import { loggers } from "@/lib/logger"

interface Props {
  message: UIMessage
  /** True when this is the most recent assistant message and we're still streaming. */
  isStreaming?: boolean
  /** True when this is the most recent assistant message in the list. */
  isLastAssistant?: boolean
  /** Lookup table for resolving senderId → Character (team sessions). */
  characterById?: Map<string, Character>
  onCopy?: () => void
  onRegenerate?: () => void | Promise<void>
  onEditResend?: (messageId: string, newText: string) => void | Promise<void>
}

export function MessageRenderer({
  message,
  isStreaming = false,
  isLastAssistant = false,
  characterById,
  onCopy,
  onRegenerate,
  onEditResend,
}: Props) {
  const t = useTranslations("chat.message")
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [shared, setShared] = useState(false)
  const { copied, copy } = useCopy({ logger: loggers.chat, scope: "chat" })

  const bookmarkedIds = useChatStore((s) => s.bookmarkedIds)
  const toggleBookmark = useChatStore((s) => s.toggleBookmark)
  const isBookmarked = bookmarkedIds.includes(message.id)

  // For team-session assistant messages, resolve which character spoke.
  const senderId = (message as { metadata?: { senderId?: string } }).metadata?.senderId
  const speaker = useMemo(() => {
    if (!senderId || !characterById) return null
    return characterById.get(senderId) ?? null
  }, [senderId, characterById])

  // Mention highlighting pattern over known character names. Honor longest
  // match first so e.g. `@Alice Smith` wins over `@Alice`.
  const mentionPattern = useMemo(() => {
    if (!characterById || characterById.size === 0) return null
    const names = [...characterById.values()]
      .map((c) => c.name)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    if (names.length === 0) return null
    return new RegExp(`@(${names.join("|")})\\b`, "gi")
  }, [characterById])

  const startEdit = () => {
    setDraft(extractText(message))
    setEditing(true)
  }

  const submitEdit = () => {
    const next = draft.trim()
    if (!next) return
    setEditing(false)
    void onEditResend?.(message.id, next)
  }

  const cancelEdit = () => {
    setEditing(false)
    setDraft("")
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      submitEdit()
    } else if (e.key === "Escape") {
      e.preventDefault()
      cancelEdit()
    }
  }

  const handleCopy = useCallback(async () => {
    const text = extractText(message)
    if (!text) return
    const ok = await copy(text)
    if (ok) onCopy?.()
  }, [message, copy, onCopy])

  const handleShare = useCallback(async () => {
    const text = extractText(message)
    if (!text) return
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ text })
      } else {
        await navigator.clipboard.writeText(text)
      }
      setShared(true)
      window.setTimeout(() => setShared(false), 1500)
    } catch (err) {
      // Web Share API can throw on user cancel — that's not a real error.
      const name = (err as { name?: string })?.name
      if (name !== "AbortError") {
        loggers.chat.warn("share failed", {
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }, [message])

  const usage = (message as { metadata?: { usage?: UsageInfo } }).metadata?.usage

  return (
    <Message from={message.role}>
      {speaker && message.role === "assistant" && (
        <div className="mb-1 flex items-center gap-2 self-start text-xs">
          <span
            className="flex size-5 items-center justify-center rounded-full text-[10px]"
            style={{
              backgroundColor: avatarColor(speaker),
              color: "white",
            }}
            aria-hidden
          >
            {avatarGlyph(speaker)}
          </span>
          <span className="font-medium" style={{ color: avatarColor(speaker) }}>
            {speaker.name}
          </span>
        </div>
      )}

      {editing ? (
        <div
          className={cn(
            "flex w-full max-w-full flex-col gap-2",
            message.role === "user" && "items-end"
          )}
        >
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            autoFocus
            rows={Math.min(10, draft.split("\n").length + 1)}
            className="min-h-[60px] resize-none"
          />
          <div className="flex justify-end gap-2 text-xs">
            <Button variant="ghost" size="sm" onClick={cancelEdit}>
              {t("editingCancel")}
            </Button>
            <Button size="sm" onClick={submitEdit}>
              {t("editingSubmit")}
            </Button>
          </div>
        </div>
      ) : (
        <MessageContent>
          {message.parts.map((part, i) =>
            renderPart(
              part,
              `${message.id}-${i}`,
              isStreaming,
              message.role === "user" ? mentionPattern : null,
              characterById,
              message.id,
              t
            )
          )}
        </MessageContent>
      )}

      {!editing && (
        <MessageActions
          className={cn(
            "text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100",
            message.role === "user" ? "ml-auto" : ""
          )}
        >
          {usage && message.role === "assistant" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="font-mono">
                  ↑{usage.inputTokens ?? 0} ↓{usage.outputTokens ?? 0}
                  {usage.totalCostUsd !== undefined && ` · $${usage.totalCostUsd.toFixed(4)}`}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <UsageBreakdown usage={usage} />
              </TooltipContent>
            </Tooltip>
          )}

          <MessageAction
            tooltip={copied ? t("copyDone") : t("copyTooltip")}
            label={t("copyLabel")}
            onClick={handleCopy}
          >
            {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          </MessageAction>

          <MessageAction
            tooltip={shared ? t("shareDone") : t("shareTooltip")}
            label={t("shareLabel")}
            onClick={handleShare}
          >
            <Share2Icon className="size-3.5" />
          </MessageAction>

          <MessageAction
            tooltip={isBookmarked ? t("bookmarkRemoveTooltip") : t("bookmarkTooltip")}
            label={t("bookmarkLabel")}
            onClick={() => toggleBookmark(message.id)}
            className={cn(isBookmarked && "text-yellow-500")}
          >
            <BookmarkIcon className={cn("size-3.5", isBookmarked && "fill-current")} />
          </MessageAction>

          {message.role === "user" && onEditResend && (
            <MessageAction tooltip={t("editTooltip")} label={t("editLabel")} onClick={startEdit}>
              <PencilIcon className="size-3.5" />
            </MessageAction>
          )}

          {message.role === "assistant" && isLastAssistant && onRegenerate && (
            <MessageAction
              tooltip={t("regenerateTooltip")}
              label={t("regenerateLabel")}
              onClick={() => void onRegenerate()}
              disabled={isStreaming}
            >
              <RefreshCcwIcon className="size-3.5" />
            </MessageAction>
          )}
        </MessageActions>
      )}
    </Message>
  )
}

function UsageBreakdown({ usage }: { usage: UsageInfo }) {
  const t = useTranslations("chat.message")
  return (
    <div className="space-y-0.5 font-mono text-xs">
      <div>{t("usageInput", { n: usage.inputTokens ?? 0 })}</div>
      <div>{t("usageOutput", { n: usage.outputTokens ?? 0 })}</div>
      {usage.cacheReadInputTokens !== undefined && usage.cacheReadInputTokens > 0 && (
        <div>{t("usageCacheHit", { n: usage.cacheReadInputTokens })}</div>
      )}
      {usage.cacheCreationInputTokens !== undefined && usage.cacheCreationInputTokens > 0 && (
        <div>{t("usageCacheWrite", { n: usage.cacheCreationInputTokens })}</div>
      )}
      {usage.totalCostUsd !== undefined && (
        <div>{t("usageCost", { cost: usage.totalCostUsd.toFixed(4) })}</div>
      )}
    </div>
  )
}

function highlightMentions(
  text: string,
  pattern: RegExp,
  characterById: Map<string, Character>
): React.ReactNode[] {
  pattern.lastIndex = 0
  const out: React.ReactNode[] = []
  let last = 0
  const charByLowerName = new Map<string, Character>()
  for (const c of characterById.values()) {
    charByLowerName.set(c.name.toLowerCase(), c)
  }
  let match: RegExpExecArray | null
  let key = 0
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      out.push(text.slice(last, match.index))
    }
    const name = match[1]
    const c = charByLowerName.get(name.toLowerCase())
    out.push(
      <span
        key={`m-${key++}-${match.index}`}
        className="rounded bg-muted px-1 font-medium"
        style={c ? { color: avatarColor(c) } : undefined}
      >
        {match[0]}
      </span>
    )
    last = match.index + match[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out.length > 0 ? out : [text]
}

function extractText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => (p as { type?: string }).type === "text")
    .map((p) => p.text)
    .join("\n\n")
}

interface TodoEntry {
  content: string
  status: "pending" | "in_progress" | "completed"
  activeForm?: string
}

function parseTodoInput(input: unknown): TodoEntry[] | null {
  if (!input || typeof input !== "object") return null
  const todos = (input as { todos?: unknown }).todos
  if (!Array.isArray(todos) || todos.length === 0) return null
  const out: TodoEntry[] = []
  for (const t of todos) {
    if (!t || typeof t !== "object") return null
    const content = (t as { content?: unknown }).content
    const status = (t as { status?: unknown }).status
    const activeForm = (t as { activeForm?: unknown }).activeForm
    if (typeof content !== "string") return null
    if (status !== "pending" && status !== "in_progress" && status !== "completed") return null
    out.push({
      content,
      status,
      activeForm: typeof activeForm === "string" ? activeForm : undefined,
    })
  }
  return out
}

function TodoStatusGlyph({ status }: { status: TodoEntry["status"] }) {
  if (status === "completed") {
    return <CheckCircle2Icon className="size-3.5 shrink-0 text-green-600" />
  }
  if (status === "in_progress") {
    return <ClockIcon className="size-3.5 shrink-0 animate-pulse text-yellow-600" />
  }
  return <CircleIcon className="size-3.5 shrink-0 text-muted-foreground" />
}

function renderPart(
  part: UIMessage["parts"][number],
  key: string,
  isStreaming: boolean,
  mentionPattern: RegExp | null,
  characterById: Map<string, Character> | undefined,
  messageId: string | undefined,
  t: ReturnType<typeof useTranslations>
) {
  const type = (part as { type?: string }).type
  if (!type) return null

  if (type === "text") {
    const text = (part as { text?: string }).text ?? ""
    if (mentionPattern && characterById) {
      const segments = highlightMentions(text, mentionPattern, characterById)
      return (
        <span key={key} className="whitespace-pre-wrap">
          {segments}
        </span>
      )
    }

    if (isStreaming) {
      return <MessageResponse key={key}>{text}</MessageResponse>
    }

    return (
      <MarkdownRenderer
        key={key}
        content={text}
        messageId={messageId}
        className="size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      />
    )
  }

  if (type === "reasoning") {
    const text = (part as { text?: string }).text ?? ""
    const stillStreaming = isStreaming && (part as { state?: string }).state !== "done"
    return (
      <Reasoning key={key} isStreaming={stillStreaming}>
        <ReasoningTrigger />
        <ReasoningContent>{text}</ReasoningContent>
      </Reasoning>
    )
  }

  if (type === "file") {
    const url = (part as { url?: string }).url
    const mediaType = (part as { mediaType?: string }).mediaType
    if (url && mediaType?.startsWith("image/")) {
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={key}
          src={url}
          alt={(part as { filename?: string }).filename ?? t("attachmentAlt")}
          className="max-h-64 max-w-xs rounded-md border"
        />
      )
    }
    return null
  }

  // Special-case Claude's TodoWrite tool: render as a structured task list.
  if (type === "tool-TodoWrite") {
    const tp = part as ToolUIPart
    const todos = parseTodoInput(tp.input)
    if (todos) {
      const completed = todos.filter((todo) => todo.status === "completed").length
      return (
        <Task key={key} defaultOpen className="not-prose mb-2 w-full">
          <TaskTrigger title={t("todoPlanTitle", { done: completed, total: todos.length })} />
          <TaskContent>
            {todos.map((todo, i) => (
              <TaskItem
                key={i}
                className={cn(
                  "flex items-start gap-2",
                  todo.status === "completed" && "text-muted-foreground line-through",
                  todo.status === "in_progress" && "text-foreground"
                )}
              >
                <TodoStatusGlyph status={todo.status} />
                <span className="min-w-0 flex-1 break-words">
                  {todo.status === "in_progress" && todo.activeForm
                    ? todo.activeForm
                    : todo.content}
                </span>
              </TaskItem>
            ))}
          </TaskContent>
        </Task>
      )
    }
    // Falls through to generic Tool rendering below.
  }

  if (typeof type === "string" && type.startsWith("tool-")) {
    const tp = part as ToolUIPart
    return (
      <Tool key={key} defaultOpen={tp.state === "input-available"}>
        <ToolHeader type={tp.type} state={tp.state} />
        <ToolContent>
          <ToolBody part={tp} />
        </ToolContent>
      </Tool>
    )
  }

  return null
}
