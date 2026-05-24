"use client"

import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
} from "@/components/ai-elements/message"
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning"
import { Task, TaskContent, TaskItem, TaskTrigger } from "@/components/ai-elements/task"
import { Tool, ToolBody, ToolHeader, ToolContent, ToolInput } from "@/components/ai-elements/tool"
import { ErrorTraceDetails } from "@/components/ai-elements/error-trace"
import { ErrorParsedView } from "@/components/chat/error-parsed-view"
import { normalizeErrorText } from "@/lib/error-parsers"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { StreamingTextPart } from "@/components/chat/streaming-text-part"
import { A2UIPart } from "@/components/chat/message-parts/a2ui-part"
import { InboundA2UIRenderer } from "@/components/chat/message-parts/inbound-a2ui-renderer"
import { SubagentPart } from "@/components/chat/message-parts/subagent-part"
import { AgentTeamDispatchPart } from "@/components/chat/message-parts/agent-team-dispatch-part"
import { ArtifactPart } from "@/components/chat/message-parts/artifact-part"
import { SourcesPart } from "@/components/chat/message-parts/sources-part"
import { TerminalToolPart } from "@/components/chat/message-parts/terminal-tool-part"
import { MCPToolCard, isStructuredMcpToolType } from "@/components/chat/message-parts/mcp-tool-card"
import { CanvasInlinePart } from "@/components/chat/message-parts/canvas-inline-part"
import { BranchNavigator } from "@/components/chat/branch-navigator"
import { TriggerBadge } from "@/components/chat/trigger-badge"
import type {
  A2UIPart as A2UIPartType,
  AgentTeamDispatchPart as AgentTeamDispatchPartType,
  ArtifactPart as ArtifactPartType,
  CanvasInlinePart as CanvasInlinePartType,
  SourcesPart as SourcesPartType,
  SubagentPart as SubagentPartType,
} from "@/lib/claude/parts-extensions"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
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
import React, { memo, useCallback, useMemo, useState, type KeyboardEvent } from "react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { avatarColor, avatarGlyph } from "@/lib/ui/avatar"
import { useChatStore } from "@/stores/chat"
import { useCopy } from "@/hooks/ui/use-copy"
import { loggers } from "@/lib/logging"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import {
  getMessagePartRenderer,
  subscribeMessagePartRenderers,
  getMessagePartRenderersRevision,
} from "@/lib/plugin/api/message-part-renderers"
import { useSyncExternalStore } from "react"
import { PerfBoundary } from "@/lib/perf"

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

function usePluginPartRegistryRevision(): number {
  return useSyncExternalStore(
    subscribeMessagePartRenderers,
    getMessagePartRenderersRevision,
    getMessagePartRenderersRevision
  )
}

class PluginPartErrorBoundary extends React.Component<
  {
    type: string
    pluginId: string
    children: React.ReactNode
  },
  { error: Error | null }
> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error): void {
    loggers.chat.warn("plugin message-part renderer threw", {
      pluginId: this.props.pluginId,
      partType: this.props.type,
      err: error.message,
    })
  }
  render() {
    if (this.state.error) {
      return (
        <div
          data-testid="plugin-part-error"
          data-plugin-id={this.props.pluginId}
          data-part-type={this.props.type}
          className="my-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          Plugin renderer for &quot;{this.props.type}&quot; crashed: {this.state.error.message}
        </div>
      )
    }
    return this.props.children
  }
}

function MessageRendererInner({
  message,
  isStreaming = false,
  isLastAssistant = false,
  characterById,
  onCopy,
  onRegenerate,
  onEditResend,
}: Props) {
  // Re-render when a plugin registers / unregisters a message-part renderer.
  usePluginPartRegistryRevision()
  const t = useTranslations("chat.message")
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [shared, setShared] = useState(false)
  const { copied, copy } = useCopy({ logger: loggers.chat, scope: "chat" })

  const isBookmarked = useChatStore(
    useCallback((s) => s.bookmarkedIds.includes(message.id), [message.id])
  )
  const toggleBookmark = useChatStore((s) => s.toggleBookmark)

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
    // Diagnostic: per-message boundary id so the PerfHud lists one row per
    // message — `clear` the HUD, stream a turn, and watch which `chat:msg:*`
    // rows reappear to see whether only the streaming row re-renders (memo
    // holding) or every row does (memo busted). Revert to a stable
    // `id="chat:message"` once the repeated-render question is settled.
    <PerfBoundary id={`chat:msg:${message.id.slice(-6)}`}>
      <Message from={message.role}>
        {speaker &&
          message.role === "assistant" &&
          (() => {
            const speakerColor = avatarColor(speaker)
            return (
              <div className="mb-1 flex items-center gap-2 self-start text-xs">
                <Avatar className="size-5">
                  <AvatarFallback
                    className="text-[10px] text-white"
                    style={{ backgroundColor: speakerColor }}
                    aria-hidden
                  >
                    {avatarGlyph(speaker)}
                  </AvatarFallback>
                </Avatar>
                <span className="font-medium" style={{ color: speakerColor }}>
                  {speaker.name}
                </span>
              </div>
            )
          })()}

        <PluginExtensionSlot point="chat.message.before" className="mb-1 empty:hidden" />

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
            {(() => {
              const inboundA2UI = (
                message as {
                  metadata?: {
                    inboundA2UI?: import("@/lib/connectors/adapters/_shared/inbound-a2ui-types").InboundA2UIBlock
                  }
                }
              ).metadata?.inboundA2UI
              if (!inboundA2UI) return null
              return <InboundA2UIRenderer block={inboundA2UI} className="mb-2" />
            })()}
            {message.parts.map((part, i) => (
              <MessagePart
                key={`${message.id}-${i}`}
                part={part}
                partKey={`${message.id}-${i}`}
                isStreaming={isStreaming}
                mentionPattern={message.role === "user" ? mentionPattern : null}
                characterById={characterById}
                messageId={message.id}
                t={t}
              />
            ))}
          </MessageContent>
        )}

        <PluginExtensionSlot point="chat.message.after" className="mt-1 empty:hidden" />

        {/* Trigger audit badge — surfaces workflows fired by this message via */}
        {/* `lib/chat/trigger-audit-ring`. Only renders when ≥1 trigger fired. */}
        {(() => {
          const sessionId =
            typeof (message as { metadata?: { sessionId?: unknown } }).metadata?.sessionId ===
            "string"
              ? ((message as { metadata?: { sessionId?: string } }).metadata!.sessionId as string)
              : null
          if (!sessionId) return null
          return <TriggerBadge sessionId={sessionId} messageId={message.id} />
        })()}

        {/* ADR-0026 §5 §A — revived hover-action slot. Distinct from the */}
        {/* footer below: this slot is visible above the message body on hover, */}
        {/* the footer holds host copy/regenerate controls. */}
        <PluginExtensionSlot
          point="chat.message.actions"
          className={cn(
            "mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 empty:hidden",
            message.role === "user" ? "ml-auto" : ""
          )}
        />

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

            {message.role === "assistant" && <BranchNavigator message={message} className="mx-1" />}

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

            <PluginExtensionSlot
              point="chat.message.footer"
              className="flex items-center gap-1 empty:hidden"
            />
          </MessageActions>
        )}
      </Message>
    </PerfBoundary>
  )
}

export const MessageRenderer = memo(
  MessageRendererInner,
  (prev, next) =>
    prev.message === next.message &&
    prev.isStreaming === next.isStreaming &&
    prev.isLastAssistant === next.isLastAssistant &&
    prev.characterById === next.characterById &&
    prev.onCopy === next.onCopy &&
    prev.onRegenerate === next.onRegenerate &&
    prev.onEditResend === next.onEditResend
)

MessageRenderer.displayName = "MessageRenderer"

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
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      out.push(text.slice(last, match.index))
    }
    const name = match[1]
    const c = charByLowerName.get(name.toLowerCase())
    out.push(
      <span
        key={`m-${match.index}`}
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

/**
 * Memoized boundary around a single message part. Parts inside a finalized
 * message keep stable references (the adapter only replaces the changed
 * message object, not its parts), so when `MessageRenderer` re-renders for an
 * unrelated reason this lets React skip re-reconciling every part subtree —
 * the expensive ones being `<Tool>` cards and `<MarkdownRenderer>`. Without
 * this, each re-render rebuilt the whole part tree (the ~11ms/row cost the
 * PerfHud surfaced). The default shallow prop compare is exactly right here:
 * `part` / `mentionPattern` / `characterById` / `t` are all reference-stable
 * while the message is unchanged.
 */
const MessagePart = memo(function MessagePart({
  part,
  partKey,
  isStreaming,
  mentionPattern,
  characterById,
  messageId,
  t,
}: {
  part: UIMessage["parts"][number]
  partKey: string
  isStreaming: boolean
  mentionPattern: RegExp | null
  characterById: Map<string, Character> | undefined
  messageId: string | undefined
  t: ReturnType<typeof useTranslations>
}) {
  return renderPart(part, partKey, isStreaming, mentionPattern, characterById, messageId, t)
})
MessagePart.displayName = "MessagePart"

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

  if (type === "artifact") {
    return <ArtifactPart key={key} part={part as unknown as ArtifactPartType} />
  }

  if (type === "sources") {
    return <SourcesPart key={key} part={part as unknown as SourcesPartType} />
  }

  if (type === "canvas") {
    return <CanvasInlinePart key={key} part={part as unknown as CanvasInlinePartType} />
  }

  if (type === "a2ui") {
    return <A2UIPart key={key} part={part as unknown as A2UIPartType} _messageId={messageId} />
  }

  if (type === "subagent") {
    return <SubagentPart key={key} part={part as unknown as SubagentPartType} />
  }

  if (type === "agent-team-dispatch") {
    const dp = part as unknown as AgentTeamDispatchPartType
    const fromName = characterById?.get(dp.from)?.name
    return <AgentTeamDispatchPart key={key} part={dp} fromName={fromName} />
  }

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
      return <StreamingTextPart key={key} text={text} isStreaming={isStreaming} />
    }

    return (
      <MarkdownRenderer
        key={key}
        content={text}
        messageId={messageId}
        isStreaming={isStreaming}
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
    const filename = (part as { filename?: string }).filename

    if (url && mediaType?.startsWith("image/")) {
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={key}
          src={url}
          alt={filename ?? t("attachmentAlt")}
          className="max-h-64 max-w-xs rounded-md border"
        />
      )
    }

    if (!url) return null

    // Non-image file: render as a downloadable link
    const displayName = filename ?? url
    return (
      <a
        key={key}
        href={url}
        download={displayName}
        className="inline-flex items-center gap-1.5 rounded border px-2 py-1 text-sm hover:bg-muted"
        target="_blank"
        rel="noopener noreferrer"
      >
        <span aria-hidden>📎</span>
        {displayName}
      </a>
    )
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

  // Plugin-contributed part types — checked before the generic tool fallback
  // so a plugin can override custom types it owns, but AFTER the host's own
  // hard-coded parts so plugins cannot shadow `artifact` / `a2ui` / etc.
  const pluginEntry =
    typeof type === "string" && !type.startsWith("tool-") ? getMessagePartRenderer(type) : undefined
  if (pluginEntry) {
    const PluginRenderer = pluginEntry.component
    return (
      <PluginPartErrorBoundary key={key} type={pluginEntry.type} pluginId={pluginEntry.pluginId}>
        <PluginRenderer part={part} messageId={messageId} isStreaming={isStreaming} />
      </PluginPartErrorBoundary>
    )
  }

  if (typeof type === "string" && type.startsWith("tool-")) {
    const tp = part as ToolUIPart
    // Route tool-Bash to the Terminal-style renderer (which falls back to the
    // generic ToolBody once the call completes).
    if (type === "tool-Bash" && tp.state !== "output-error") {
      return <TerminalToolPart key={key} part={tp} />
    }
    // Structured cognia MCP / Claude-builtin tools — display the call shell
    // (header + status) plus the structured card body. MCPToolCard internally
    // falls back to ToolBody when the payload can't be parsed.
    if (isStructuredMcpToolType(type) && tp.state !== "output-error") {
      return (
        <Tool key={key} defaultOpen={tp.state === "input-available"}>
          <ToolHeader type={tp.type} state={tp.state} />
          <ToolContent>
            <MCPToolCard part={tp} />
          </ToolContent>
        </Tool>
      )
    }
    // Error path: surface a structured ErrorTraceDetails alert instead of the
    // plain `<pre>` ToolOutput renders for `errorText`. We keep the input
    // section so the user can still see what was called.
    if (tp.state === "output-error") {
      const rawError = (tp as { errorText?: unknown }).errorText
      return (
        <Tool key={key} defaultOpen>
          <ToolHeader type={tp.type} state={tp.state} />
          <ToolContent>
            {tp.input !== undefined && tp.input !== null && <ToolInput input={tp.input} />}
            <ErrorTraceDetails
              error={{ message: normalizeErrorText(rawError, t("toolCallFailed")) }}
              title={t("toolCallFailed")}
              className="mt-2"
              body={
                <ErrorParsedView
                  rawError={rawError}
                  toolType={tp.type}
                  fallback={t("toolCallFailed")}
                />
              }
            />
          </ToolContent>
        </Tool>
      )
    }
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
