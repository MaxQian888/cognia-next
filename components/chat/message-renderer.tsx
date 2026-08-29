"use client"

import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
} from "@/components/ai-elements/message"
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning"
import { selectStreamdownPlugins } from "@/components/ai-elements/streamdown-plugins"
import { Tool, ToolHeader, ToolContent } from "@/components/ai-elements/tool"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { MessageShell } from "@/components/chat/message-shell"
import {
  chatMarkdownUrlTransform,
  chatStreamdownRehypePlugins,
} from "@/components/chat/markdown/rendering-policy"
import {
  FINALIZED_MARKDOWN_LAZY_THRESHOLD,
  FinalizedLongTextPart,
  StreamingTextPart,
  createStreamingComponents,
} from "@/components/chat/streaming-text-part"
import { A2UIPart } from "@/components/chat/message-parts/a2ui-part"
import { InboundA2UIRenderer } from "@/components/chat/message-parts/inbound-a2ui-renderer"
import { SubagentTree } from "@/components/chat/message-parts/subagent-tree"
import { AgentTeamDispatchPart } from "@/components/chat/message-parts/agent-team-dispatch-part"
import { SquadRunPart } from "@/components/chat/message-parts/squad-run-part"
import { SquadGatePart } from "@/components/chat/message-parts/squad-gate-part"
import { ArtifactPart } from "@/components/chat/message-parts/artifact-part"
import { SourcesPart } from "@/components/chat/message-parts/sources-part"
import { GroundingPart } from "@/components/chat/message-parts/grounding-part"
import { TerminalToolPart } from "@/components/chat/message-parts/terminal-tool-part"
import { ToolDetailBody, isBashToolPart } from "@/components/chat/message-parts/tool-detail-body"
import { CanvasInlinePart } from "@/components/chat/message-parts/canvas-inline-part"
import { FilePartPreview } from "@/components/chat/message-parts/file-part-preview"
import { AttachmentTextCard } from "@/components/chat/message-parts/attachment-text-card"
import {
  MessageImageGallery,
  type MessageImageGalleryProps,
} from "@/components/chat/renderers/message-image-gallery"
import { MessageImageCollectionProvider } from "@/components/chat/renderers/message-image-collection"
import { PluginSurface } from "@/components/plugins/plugin-surface"
import { UnknownPartCard } from "@/components/chat/message-parts/unknown-part-card"
import {
  HookNoticeRow,
  type HookNoticePartData,
} from "@/components/chat/message-parts/hook-notice-part"
import { DiagnosticsCard } from "@/components/chat/message-parts/diagnostics-card"
import { SlashCommandResultChip } from "@/components/chat/message-parts/slash-command-result-chip"
import {
  DIAGNOSTICS_PART_TYPE,
  isSystemMessageBlock,
  isSlashCommandResultBlock,
  type SystemMessageBlock,
} from "@/lib/slash-commands/system-blocks"
import { ToolCallRow } from "@/components/chat/message-parts/tool-call-row"
import { ToolUseSummaryPart } from "@/components/chat/message-parts/tool-use-summary-part"
import {
  ToolActivityGroup,
  type ToolActivityChildOptions,
  type ToolActivityGroupEntry,
} from "@/components/chat/message-parts/tool-activity-group"
import { MotionReveal } from "@/components/chat/motion/motion-reveal"
import { useMessageDisplay } from "@/hooks/chat/use-message-display"
import {
  groupAgentParts,
  isToolOnlyFlow,
  isToolPartType,
  SILENT_CONTROL_PART_TYPES,
} from "@/lib/chat/agent-flow-grouping"
import { parseTodoInput } from "@/lib/chat/todos"
import { userBubbleClass } from "@/lib/chat/message-bubble"
import { resolveToolDisplayTitle } from "@/lib/chat/tool-summary"
import type { AgentFlowMode } from "@/types/appearance"
import type { ResolvedMessageDisplayOptions } from "@/lib/chat/message-display"
import { BranchNavigator } from "@/components/chat/branch-navigator"
import { BranchPointMarker } from "@/components/chat/branch-children-chip"
import { TriggerBadge } from "@/components/chat/trigger-badge"
import { MemoryLearnedChip, MemoryRecalledChip } from "@/components/chat/memory-chips"
import { isSourcesPart, isToolUseSummaryPart } from "@/lib/claude/parts-extensions"
import type {
  A2UIPart as A2UIPartType,
  AgentTeamDispatchPart as AgentTeamDispatchPartType,
  SquadRunPart as SquadRunPartType,
  SquadGatePart as SquadGatePartType,
  ArtifactPart as ArtifactPartType,
  CanvasInlinePart as CanvasInlinePartType,
  GroundingPart as GroundingPartType,
  SourcesPart as SourcesPartType,
} from "@/lib/claude/parts-extensions"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { AnimatedActionIcon, CopyFeedbackIcon } from "@/components/shared/animated-action-icon"
import {
  LinkIcon,
  CornerUpLeftIcon,
  GitBranchIcon,
  ScissorsIcon,
  ImageIcon,
  PencilIcon,
  BrainIcon,
  RefreshCcwIcon,
  Repeat2Icon,
  Share2Icon,
  MoreHorizontalIcon,
  QuoteIcon,
} from "lucide-react"
import { BookmarkIcon as AnimatedBookmarkIcon } from "@/components/ui/bookmark"
import { CheckIcon as AnimatedCheckIcon } from "@/components/ui/check"
import { QuoteCardDialog } from "@/components/share/quote-card-dialog"
import { toast } from "sonner"
import type { ToolUIPart, UIMessage } from "ai"
import type { UsageInfo } from "@/lib/claude/adapter"
import { UsageBreakdown } from "@/components/chat/usage-breakdown"
import type { Character } from "@cognia/agent-config-types"
import React, { memo, useCallback, useMemo, useState, type KeyboardEvent } from "react"
import { useTranslations } from "next-intl"
import { buildMessagePermalink } from "@/lib/chat/message-permalink"
import { cn } from "@/lib/utils"
import { avatarColor } from "@/lib/ui/avatar"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { ReadAloudButton } from "./read-aloud-button"
import { TodoList } from "./todo-list"
import { useCopy } from "@/hooks/ui/use-copy"
import { buildMessageShareContent, writeMessageToClipboard } from "@/lib/chat/message-share"
import { resolveMessageActionCommands } from "@/lib/chat/message-action-commands"
import { loggers } from "@cognia/logging"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { MessagePluginMenu } from "@/components/chat/message-plugin-menu"
import { MessageImActions } from "@/components/chat/message-im-actions"
import { readChatTemplateRun } from "@/lib/chat/template/run"
import { requestTemplateRerun } from "@/lib/chat/template/rerun-request"
import { BranchDialog } from "@/components/chat/branch-dialog"
import { TruncateFromDialog } from "@/components/chat/truncate-from-dialog"
import { SteerStatusBadge } from "@/components/chat/message-parts/steer-status-badge"
import { SessionPeerOriginBadge } from "@/components/chat/session-peer-origin-badge"
import { dispatchComposerAppend } from "@/components/chat/composer"
import { saveMessageAsMemory } from "@/lib/chat/save-message-as-memory"
import { useProjectStore } from "@/stores/project/project-store"
import { useAsideTarget } from "@/components/context-workbench/aside-target"
import { useLiveQuery } from "dexie-react-hooks"
import { getSession } from "@/lib/db/sessions"
import {
  getMessagePartRenderer,
  subscribeMessagePartRenderers,
  getMessagePartRenderersRevision,
} from "@/lib/plugin/api/message-part-renderers"
import {
  subscribeToolResultRenderers,
  getToolResultRenderersRevision,
} from "@/lib/plugin/api/tool-result-renderers"
import { useSyncExternalStore } from "react"
import { PerfBoundary } from "@/lib/perf"
import { useAgentFileAutoFollow } from "@/hooks/agent/use-agent-file-auto-follow"
import { CheckpointAction } from "@/components/chat/checkpoint-action"
import type { RewindFilesResult } from "@/lib/claude/ipc"

interface Props {
  message: UIMessage
  /** True when this is the most recent assistant message and we're still streaming. */
  isStreaming?: boolean
  /** True when this is the most recent assistant message in the list. */
  isLastAssistant?: boolean
  /** Lookup table for resolving senderId → Character (team sessions). */
  characterById?: Map<string, Character>
  /**
   * The session-bound character in a 1:1 (direct) chat. Used as the read-aloud
   * voice when the message has no `senderId` (i.e. not a team message).
   */
  directCharacter?: Character | null
  onCopy?: () => void
  onRegenerate?: () => void | Promise<void>
  onEditResend?: (messageId: string, newText: string) => void | Promise<void>
  onRewindFiles?: (
    sessionId: string,
    checkpointId: string,
    dryRun: boolean
  ) => Promise<RewindFilesResult>
  /** Root used to resolve project-relative links in assistant Markdown. */
  projectRoot?: string | null
  /** Resolved once by the owning transcript when available. */
  messageDisplay?: ResolvedMessageDisplayOptions
}

function usePluginPartRegistryRevision(): number {
  return useSyncExternalStore(
    subscribeMessagePartRenderers,
    getMessagePartRenderersRevision,
    getMessagePartRenderersRevision
  )
}

/**
 * Re-render the message when a plugin registers / unregisters a TOOL-RESULT
 * renderer. Separate from the part registry above because the tool branch is
 * chosen by `isStructuredMcpToolPart` during render — without this, enabling a
 * plugin mid-session would leave already-rendered tool calls on the generic
 * card forever.
 */
function usePluginToolRendererRevision(): number {
  return useSyncExternalStore(
    subscribeToolResultRenderers,
    getToolResultRenderersRevision,
    getToolResultRenderersRevision
  )
}

function MessageRendererInner({
  message,
  isStreaming = false,
  isLastAssistant = false,
  characterById,
  directCharacter,
  onCopy,
  onRegenerate,
  onEditResend,
  onRewindFiles,
  projectRoot,
  messageDisplay,
}: Props) {
  useAgentFileAutoFollow({ parts: message.parts, isStreaming, projectRoot })
  // Re-render when a plugin registers / unregisters a message-part renderer.
  usePluginPartRegistryRevision()
  // ...and likewise for tool-result cards.
  usePluginToolRendererRevision()
  const t = useTranslations("chat.message")
  // Agent invocation-flow display mode (simplified / standard / detailed).
  const fallbackMessageDisplay = useMessageDisplay()
  const display = messageDisplay ?? fallbackMessageDisplay
  const agentFlowMode: AgentFlowMode = display.agentFlowMode
  // Read-aloud is gated on the global TTS toggle; the selector keeps this
  // re-render rare (settings change), not on every playback progress tick.
  const ttsEnabled = useSettingsStore((s) => s.settings?.ttsEnabled ?? false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [shared, setShared] = useState(false)
  const [richCopied, setRichCopied] = useState(false)
  const [branchOpen, setBranchOpen] = useState(false)
  const [truncateOpen, setTruncateOpen] = useState(false)
  const [cardOpen, setCardOpen] = useState(false)
  // Stable "now" for messages that carry no createdAt (impure Date read kept
  // out of render via a lazy state initializer).
  const [nowFallback] = useState(() => new Date())
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  // Non-null only inside a workbench sidechat — see `AsideTargetProvider`.
  const asideTargetSessionId = useAsideTarget()
  const branchSessionId =
    (typeof (message as { metadata?: { sessionId?: unknown } }).metadata?.sessionId === "string"
      ? ((message as { metadata?: { sessionId?: string } }).metadata!.sessionId as string)
      : undefined) ?? activeSessionId
  // Where "hand this back" should land. An aside hands back to the main
  // conversation; a branch hands back to the one it was cut from. Both are
  // "up one level", so one action covers both rather than two that differ only
  // in how they resolve the target. Null in an ordinary top-level conversation.
  const branchParentId = useLiveQuery(
    async () =>
      branchSessionId ? ((await getSession(branchSessionId))?.parentSessionId ?? null) : null,
    [branchSessionId]
  )
  const handBackTargetId = asideTargetSessionId ?? branchParentId ?? null
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)
  const messageProvider = (message as { metadata?: { provider?: string } }).metadata?.provider
  const checkpointEnabled =
    message.role === "user" &&
    branchSessionId === activeSessionId &&
    (messageProvider ?? defaultProvider ?? "anthropic") === "anthropic"
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

  // Segment the parts into tool-activity groups + standalone parts. Memoized on
  // `message.parts` so it doesn't re-run on every token or on unrelated local
  // state (editing/draft/shared/branchOpen) before the memoized children skip.
  const presentationParts = useMemo(
    () =>
      message.parts.map((part) =>
        shouldHideMessagePart(part, display)
          ? ({ type: "step-start" } as UIMessage["parts"][number])
          : part
      ),
    [display, message.parts]
  )
  const segments = useMemo(
    () => groupAgentParts(presentationParts, agentFlowMode),
    [presentationParts, agentFlowMode]
  )

  // Image file parts belong to one visual attachment group even when a text or
  // document part sits between them. Render the group at the first image's
  // transcript position and suppress the remaining individual image parts.
  const messageImageGallery = useMemo(() => {
    const items: MessageImageGalleryProps["items"] = []
    const partIndexes = new Set<number>()
    message.parts.forEach((part, index) => {
      const file = part as { type?: string; url?: string; mediaType?: string; filename?: string }
      if (file.type !== "file" || !file.url || !file.mediaType?.startsWith("image/")) return
      partIndexes.add(index)
      items.push({
        id: `${message.id}-${index}`,
        src: file.url,
        alt: file.filename ?? t("attachmentAlt"),
        filename: file.filename,
      })
    })
    return {
      items,
      partIndexes,
      firstPartIndex: partIndexes.values().next().value as number | undefined,
    }
  }, [message.id, message.parts, t])

  // Plain text of the message, for the "share as card" action + gate.
  const messageText = useMemo(() => extractText(message), [message])
  const messageShareContent = useMemo(() => buildMessageShareContent(message), [message])
  /**
   * The parameters this turn was written from, when it came from a template.
   *
   * Read defensively: `metadata` is persisted and synced, so an older build or
   * another device can have put anything there, and one hidden button is a far
   * better outcome than a transcript that will not render.
   */
  const templateRun = useMemo(
    () => readChatTemplateRun((message as { metadata?: unknown }).metadata),
    [message]
  )
  const messageActionCommands = useMemo(
    () =>
      resolveMessageActionCommands({
        role: message.role,
        hasContent: messageShareContent.hasContent,
        hasSession: Boolean(branchSessionId),
        canEdit: Boolean(onEditResend),
        canRegenerate: Boolean(isLastAssistant && onRegenerate),
        canReadAloud: ttsEnabled,
        canBringBack: Boolean(handBackTargetId),
        canRerunTemplate: Boolean(templateRun && branchSessionId),
        canSaveAsMemory: Boolean(branchSessionId),
        streaming: isStreaming,
      }),
    [
      branchSessionId,
      handBackTargetId,
      isLastAssistant,
      isStreaming,
      message.role,
      messageShareContent.hasContent,
      onEditResend,
      onRegenerate,
      templateRun,
      ttsEnabled,
    ]
  )
  const hasActionCommand = useCallback(
    (id: (typeof messageActionCommands)[number]["id"]) =>
      messageActionCommands.some((command) => command.id === id),
    [messageActionCommands]
  )
  const actionCommand = useCallback(
    (id: (typeof messageActionCommands)[number]["id"]) =>
      messageActionCommands.find((command) => command.id === id),
    [messageActionCommands]
  )

  // A turn that is nothing but tool calls has no prose to copy, quote, read
  // aloud or card, so it renders no action bar. The bar is `opacity-0` until
  // hover but still reserves a ~40px row (icon buttons) plus a `gap-2`, which
  // is what put a strip of chrome between every pair of consecutive tool calls.
  const isToolOnlyTurn = useMemo(
    () => message.role === "assistant" && isToolOnlyFlow(message.parts),
    [message.role, message.parts]
  )

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
    if (!messageShareContent.hasContent) return
    const needsRichClipboard = messageShareContent.plainText !== messageText
    const ok = needsRichClipboard
      ? await writeMessageToClipboard(messageShareContent)
      : await copy(messageShareContent.plainText)
    if (ok && needsRichClipboard) {
      setRichCopied(true)
      window.setTimeout(() => setRichCopied(false), 1500)
    }
    if (ok) onCopy?.()
  }, [messageShareContent, messageText, copy, onCopy])

  // A permalink back into THIS app (`?session=…&message=…`), not a published
  // share link — see `lib/chat/message-permalink.ts`.
  const [linkCopied, setLinkCopied] = useState(false)
  const handleCopyLink = useCallback(async () => {
    if (!branchSessionId) return
    const ok = await copy(
      buildMessagePermalink({ sessionId: branchSessionId, messageId: message.id })
    )
    if (!ok) return
    setLinkCopied(true)
    window.setTimeout(() => setLinkCopied(false), 1500)
  }, [branchSessionId, message.id, copy])

  const handleShare = useCallback(async () => {
    if (!messageShareContent.hasContent) return
    try {
      if (typeof navigator.share === "function") {
        const files = messageShareContent.shareFiles
        if (files.length > 0 && navigator.canShare?.({ files })) {
          await navigator.share({
            ...(messageShareContent.nativeShareText.trim()
              ? { text: messageShareContent.nativeShareText }
              : {}),
            files,
          })
        } else if (files.length === 0) {
          await navigator.share({ text: messageShareContent.plainText })
        } else if (!(await writeMessageToClipboard(messageShareContent))) {
          throw new Error("No compatible native share or clipboard target")
        }
      } else {
        const ok = await writeMessageToClipboard(messageShareContent)
        if (!ok) throw new Error("Clipboard unavailable")
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
  }, [messageShareContent])

  const handleBringBack = useCallback(() => {
    if (!handBackTargetId) return
    const text = extractText(message).trim()
    if (!text) return
    dispatchComposerAppend({
      text: `${text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n`,
      sessionId: handBackTargetId,
    })
    toast.success(t("bringBackDone"))
  }, [handBackTargetId, message, t])

  const handleSaveAsMemory = useCallback(async () => {
    if (!branchSessionId) return
    try {
      // Read at click time rather than subscribed: the value is used once per
      // action, and `branch-dialog.tsx` reaches for it the same way.
      const { activeProjectId } = useProjectStore.getState()
      const title = await saveMessageAsMemory({
        parts: message.parts,
        sessionId: branchSessionId,
        ...(activeProjectId ? { projectId: activeProjectId } : {}),
      })
      // Nothing readable in the turn. Saying so beats a success toast for a
      // draft that was never filed.
      if (!title) {
        toast.error(t("saveAsMemoryEmpty"))
        return
      }
      toast.success(t("saveAsMemoryDone", { title }))
    } catch (err) {
      // A PII-gate refusal arrives here, and it is a real answer the user has
      // to see — the draft was not filed and no retry will change that.
      toast.error(
        t("saveAsMemoryFailed", { reason: err instanceof Error ? err.message : String(err) })
      )
    }
  }, [branchSessionId, message.parts, t])

  const handleQuote = useCallback(() => {
    if (!branchSessionId) return
    const text = extractText(message).trim()
    if (!text) return
    dispatchComposerAppend({
      text: `${text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n`,
      sessionId: branchSessionId,
    })
  }, [branchSessionId, message])

  const usage = (message as { metadata?: { usage?: UsageInfo } }).metadata?.usage

  return (
    <PerfBoundary id="chat:message">
      <Message
        from={message.role}
        className={cn(
          // ADR-0127: the vertical rhythm between turns follows the chat
          // density surface (`--density-gap`: 0.5 / 0.75 / 1rem).
          "py-[calc(var(--density-gap,0.75rem)*0.667)] sm:py-[var(--density-gap,0.75rem)]",
          display.layout === "cards"
            ? "max-w-full"
            : display.layout === "bubbles"
              ? "max-w-[min(88%,46rem)]"
              : message.role === "user"
                ? "max-w-[min(82%,42rem)]"
                : "max-w-full"
        )}
      >
        <MessageShell
          message={message}
          display={display}
          speakerName={speaker?.name}
          speakerColor={speaker ? avatarColor(speaker) : undefined}
          isStreaming={isStreaming}
        >
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
            // `MessageContent` is `w-fit` so a user bubble hugs its text. For the
            // assistant that makes the column width follow the widest mounted
            // child — collapsing a tool card unmounts its body and the whole
            // column snaps narrow. Pin the assistant side to the full row so
            // expand/collapse never moves the width.
            // Every image in this turn — markdown `![]()`, attachment gallery,
            // tool-result screenshots — registers with one collection so the
            // lightbox pages across the whole message instead of dead-ending on
            // whichever image was clicked.
            <MessageImageCollectionProvider>
              <MessageContent
                className={cn(
                  "leading-relaxed",
                  // One module owns bubble geometry (ADR-0148). This branch used
                  // to skip the `cards` layout, which left the user bubble on
                  // ai-elements' vendored default — a colour and corner nobody
                  // chose.
                  userBubbleClass(display.layout),
                  "group-[.is-assistant]:w-full"
                )}
              >
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
                {/* Segment the parts so runs of ≥2 consecutive tool calls collapse */}
                {/* into one activity group. Subagent parts are transparent here and */}
                {/* render once below as a dispatch tree. */}
                {segments.map((segment, si) => {
                  if (segment.kind === "group") {
                    const entries: ToolActivityGroupEntry[] = segment.entries.map((e) => ({
                      part: e.part as ToolUIPart,
                      key: `${message.id}-${e.index}`,
                    }))
                    return (
                      <MotionReveal
                        key={`${message.id}-group-${si}`}
                        index={si}
                        disabled={display.motion === "off"}
                        intensity={display.motion === "expressive" ? "expressive" : "restrained"}
                      >
                        {/* Key the group on the display mode: the tool cards it wraps
                        own their open state in uncontrolled Collapsibles
                        (`defaultOpen`, read once at mount), so a live
                        standard⇄detailed switch only takes effect if the group
                        remounts and re-applies the per-mode default. */}
                        <ToolActivityGroup
                          key={`${agentFlowMode}-${display.tools}`}
                          entries={entries}
                          mode={agentFlowMode}
                          renderChild={(part, key, opts) =>
                            renderToolPart(
                              part,
                              key,
                              agentFlowMode,
                              opts,
                              message.id,
                              branchSessionId ?? undefined,
                              display.tools
                            )
                          }
                        />
                      </MotionReveal>
                    )
                  }

                  const { part, index } = segment.entry
                  const partKey = `${message.id}-${index}`
                  const partType = (part as { type?: string }).type
                  if (messageImageGallery.partIndexes.has(index)) {
                    if (index !== messageImageGallery.firstPartIndex) return null
                    return (
                      <MessageImageGallery
                        key={`${message.id}-image-gallery`}
                        items={messageImageGallery.items}
                      />
                    )
                  }
                  // Tool cards and reasoning read the display mode only through their
                  // Collapsible's uncontrolled `defaultOpen`, snapshotted at mount —
                  // a live standard⇄detailed switch changes the prop but never
                  // re-opens or re-collapses an already-mounted card. Fold the mode
                  // into just those parts' key so switching the display mode remounts
                  // them and re-applies the per-mode default. Prose keeps a
                  // mode-agnostic key (no reflow), and the outer MotionReveal key
                  // stays stable so the entrance animation isn't replayed on a toggle.
                  const disclosureKey = isToolPartType(partType)
                    ? `${agentFlowMode}-${display.tools}`
                    : partType === "reasoning"
                      ? `${agentFlowMode}-${display.reasoning}`
                      : partType === "sources"
                        ? display.sources
                        : null
                  const nodeKey = disclosureKey ? `${partKey}-${disclosureKey}` : partKey
                  const node = (
                    <MessagePart
                      key={nodeKey}
                      part={part}
                      partKey={partKey}
                      isStreaming={isStreaming}
                      mentionPattern={message.role === "user" ? mentionPattern : null}
                      characterById={characterById}
                      messageId={message.id}
                      sessionId={branchSessionId ?? undefined}
                      mode={agentFlowMode}
                      display={display}
                      t={t}
                      projectRoot={projectRoot}
                    />
                  )
                  // Give tool cards/rows and dispatch banners a one-shot entrance;
                  // leave text/markdown untouched to avoid wrapping prose in extra
                  // block boxes.
                  return isToolPartType(partType) || partType === "agent-team-dispatch" ? (
                    <MotionReveal
                      key={partKey}
                      index={si}
                      disabled={display.motion === "off"}
                      intensity={display.motion === "expressive" ? "expressive" : "restrained"}
                    >
                      {node}
                    </MotionReveal>
                  ) : (
                    node
                  )
                })}
                <SubagentTree parts={message.parts} mode={agentFlowMode} />
              </MessageContent>
            </MessageImageCollectionProvider>
          )}

          {/* Delivery state of a mid-run follow-up. Self-hides for every message
            that is not a pending steer. */}
          <SteerStatusBadge message={message} sessionId={branchSessionId} />
          <SessionPeerOriginBadge metadata={message.metadata} />

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

          {/* Memory transparency chips — "learned N" + "recalled N" for completed */}
          {/* assistant turns. Mounted only when not streaming so the liveQuery */}
          {/* inside the chips never runs in the token-delta hot path. */}
          {message.role === "assistant" && !isStreaming && (
            <div className="mt-1 flex flex-wrap items-center gap-1 empty:hidden">
              <MemoryLearnedChip messageId={message.id} />
              {(() => {
                const sourcesPart = (message.parts as unknown[]).find(isSourcesPart)
                return sourcesPart ? <MemoryRecalledChip part={sourcesPart} /> : null
              })()}
            </div>
          )}
          {/* ADR-0026 §5 §A — revived hover-action slot. Distinct from the */}
          {/* footer below: this slot is visible above the message body on hover, */}
          {/* the footer holds host copy/regenerate controls. */}
          {/* User-side rows sit inside the shell body (a block), so `ml-auto`
              only right-aligns them when the row is `w-fit` — a block-level
              flex row with auto width ignores auto margins and pins to the
              left under the right-aligned bubble. */}
          <PluginExtensionSlot
            point="chat.message.actions"
            className={cn(
              "mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 empty:hidden",
              message.role === "user" ? "ml-auto w-fit" : ""
            )}
          />

          {/* Plugin context-menu items targeting the `chat:message` zone
            (ctx.contextMenu.register) — hover ellipsis dropdown. Renders
            nothing when no plugin contributed items. */}
          <div
            className={cn(
              "opacity-0 transition-opacity group-hover:opacity-100 empty:hidden",
              message.role === "user" ? "ml-auto w-fit" : ""
            )}
          >
            <MessagePluginMenu
              messageId={message.id}
              sessionId={
                typeof (message as { metadata?: { sessionId?: unknown } }).metadata?.sessionId ===
                "string"
                  ? ((message as { metadata?: { sessionId?: string } }).metadata!
                      .sessionId as string)
                  : undefined
              }
            />
          </div>

          {!editing && !isToolOnlyTurn && display.actions !== "all" && (
            <MessageActions
              className={cn(
                "text-xs text-muted-foreground transition-opacity",
                display.actions === "hover" && "opacity-0 group-hover:opacity-100",
                message.role === "user" ? "ml-auto w-fit" : ""
              )}
            >
              <MessageAction
                tooltip={copied || richCopied ? t("copyDone") : t("copyTooltip")}
                label={t("copyLabel")}
                onClick={handleCopy}
              >
                <CopyFeedbackIcon copied={copied || richCopied} size={14} />
              </MessageAction>

              {hasActionCommand("edit") && onEditResend && (
                <MessageAction
                  tooltip={t("editTooltip")}
                  label={t("editLabel")}
                  onClick={startEdit}
                >
                  <PencilIcon className="size-3.5" />
                </MessageAction>
              )}

              {hasActionCommand("rerunTemplate") && templateRun && branchSessionId && (
                <MessageAction
                  tooltip={t("rerunTemplateTooltip")}
                  label={t("rerunTemplateLabel")}
                  onClick={() =>
                    requestTemplateRerun({ sessionId: branchSessionId, run: templateRun })
                  }
                  disabled={actionCommand("rerunTemplate")?.disabled}
                >
                  <Repeat2Icon className="size-3.5" />
                </MessageAction>
              )}

              {hasActionCommand("saveAsMemory") && (
                <MessageAction
                  tooltip={t("saveAsMemoryTooltip")}
                  label={t("saveAsMemoryLabel")}
                  onClick={() => void handleSaveAsMemory()}
                  disabled={actionCommand("saveAsMemory")?.disabled}
                >
                  <BrainIcon className="size-3.5" />
                </MessageAction>
              )}

              {hasActionCommand("regenerate") && onRegenerate && (
                <MessageAction
                  tooltip={t("regenerateTooltip")}
                  label={t("regenerateLabel")}
                  onClick={() => void onRegenerate()}
                  disabled={actionCommand("regenerate")?.disabled}
                >
                  <RefreshCcwIcon className="size-3.5" />
                </MessageAction>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    aria-label={t("moreLabel")}
                  >
                    <MoreHorizontalIcon className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align={message.role === "user" ? "end" : "start"}>
                  <DropdownMenuItem onSelect={() => void handleShare()}>
                    <Share2Icon className="size-4" />
                    {t("shareLabel")}
                  </DropdownMenuItem>
                  {hasActionCommand("quote") && branchSessionId && (
                    <DropdownMenuItem onSelect={handleQuote}>
                      <QuoteIcon className="size-4" />
                      {t("quoteLabel")}
                    </DropdownMenuItem>
                  )}
                  {hasActionCommand("copyLink") && branchSessionId && (
                    <DropdownMenuItem onSelect={() => void handleCopyLink()}>
                      <LinkIcon className="size-4" />
                      {t("copyLinkLabel")}
                    </DropdownMenuItem>
                  )}
                  {hasActionCommand("shareCard") && (
                    <DropdownMenuItem onSelect={() => setCardOpen(true)}>
                      <ImageIcon className="size-4" />
                      {t("shareCardLabel")}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onSelect={() => toggleBookmark(message.id)}>
                    <AnimatedBookmarkIcon className="size-4" />
                    {isBookmarked ? t("bookmarkRemoveTooltip") : t("bookmarkTooltip")}
                  </DropdownMenuItem>
                  {hasActionCommand("branch") && branchSessionId && (
                    <DropdownMenuItem
                      disabled={actionCommand("branch")?.disabled}
                      onSelect={() => setBranchOpen(true)}
                    >
                      <GitBranchIcon className="size-4" />
                      {t("branchLabel")}
                    </DropdownMenuItem>
                  )}
                  {hasActionCommand("truncate") && branchSessionId && (
                    <DropdownMenuItem
                      disabled={actionCommand("truncate")?.disabled}
                      onSelect={() => setTruncateOpen(true)}
                    >
                      <ScissorsIcon className="size-4" />
                      {t("truncateFromLabel")}
                    </DropdownMenuItem>
                  )}
                  {hasActionCommand("bringBack") && handBackTargetId && (
                    <DropdownMenuItem onSelect={handleBringBack}>
                      <CornerUpLeftIcon className="size-4" />
                      {t("bringBackLabel")}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* ADR-0127: read-aloud is a host command (`readAloud`) and must
                stay reachable under every preset, not only `inspector` — the
                `all` branch below is the only place it used to render. */}
              {hasActionCommand("readAloud") && (
                <ReadAloudButton
                  messageId={message.id}
                  text={extractText(message)}
                  character={speaker ?? directCharacter ?? null}
                />
              )}

              {/* IM cross-links: forward this text to an IM conversation, or
                  lift an inbound IM message into a fresh main chat. Self-hide
                  when they do not apply. */}
              <MessageImActions message={message} text={messageText} sessionId={branchSessionId} />

              <BranchNavigator message={message} className="mx-1" />
              {branchSessionId && (
                <BranchPointMarker sessionId={branchSessionId} messageId={message.id} />
              )}
            </MessageActions>
          )}

          {!editing && !isToolOnlyTurn && display.actions === "all" && (
            <MessageActions
              className={cn(
                "text-xs text-muted-foreground",
                message.role === "user" ? "ml-auto w-fit" : ""
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
                tooltip={copied || richCopied ? t("copyDone") : t("copyTooltip")}
                label={t("copyLabel")}
                onClick={handleCopy}
              >
                <CopyFeedbackIcon copied={copied || richCopied} size={14} />
              </MessageAction>

              <MessageAction
                tooltip={shared ? t("shareDone") : t("shareTooltip")}
                label={t("shareLabel")}
                onClick={handleShare}
              >
                <Share2Icon className="size-3.5" />
              </MessageAction>

              {hasActionCommand("quote") && branchSessionId && (
                <MessageAction
                  tooltip={t("quoteLabel")}
                  label={t("quoteLabel")}
                  onClick={handleQuote}
                >
                  <QuoteIcon className="size-3.5" />
                </MessageAction>
              )}

              {branchSessionId && (
                <MessageAction
                  // Deliberately worded as a *link to this message*, never as
                  // "share": the neighbouring share action publishes content,
                  // this one only navigates, and confusing the two is either a
                  // privacy accident or a dead link.
                  tooltip={linkCopied ? t("copyLinkDone") : t("copyLinkTooltip")}
                  label={t("copyLinkLabel")}
                  onClick={handleCopyLink}
                >
                  {linkCopied ? (
                    <AnimatedActionIcon icon={AnimatedCheckIcon} size={14} animateOnChange />
                  ) : (
                    <LinkIcon className="size-3.5" />
                  )}
                </MessageAction>
              )}

              {messageShareContent.hasContent && (
                <MessageAction
                  tooltip={t("shareCardTooltip")}
                  label={t("shareCardLabel")}
                  onClick={() => setCardOpen(true)}
                >
                  <ImageIcon className="size-3.5" />
                </MessageAction>
              )}

              <MessageAction
                tooltip={isBookmarked ? t("bookmarkRemoveTooltip") : t("bookmarkTooltip")}
                label={t("bookmarkLabel")}
                onClick={() => toggleBookmark(message.id)}
                className={cn(isBookmarked && "text-yellow-500")}
              >
                <AnimatedActionIcon
                  icon={AnimatedBookmarkIcon}
                  size={14}
                  animateOnChange={isBookmarked}
                  className={isBookmarked ? "fill-current" : undefined}
                />
              </MessageAction>

              {message.role === "user" && onEditResend && (
                <MessageAction
                  tooltip={t("editTooltip")}
                  label={t("editLabel")}
                  onClick={startEdit}
                >
                  <PencilIcon className="size-3.5" />
                </MessageAction>
              )}

              {message.role === "user" && branchSessionId && onRewindFiles && (
                <CheckpointAction
                  checkpointId={message.id}
                  enabled={checkpointEnabled}
                  rewindFiles={(checkpointId, dryRun) =>
                    onRewindFiles(branchSessionId, checkpointId, dryRun)
                  }
                />
              )}

              {branchSessionId && (
                <MessageAction
                  tooltip={isStreaming ? t("branchStreamingTooltip") : t("branchTooltip")}
                  label={t("branchLabel")}
                  onClick={() => setBranchOpen(true)}
                  // A branch snapshots the visible thread, so taking one mid-turn
                  // would copy a half-written reply and seed the child with an
                  // unfinished exchange. Matches the regenerate action below.
                  disabled={actionCommand("branch")?.disabled}
                >
                  <GitBranchIcon className="size-3.5" />
                </MessageAction>
              )}

              {/* The only remaining destructive path. Editing a user message used
                to delete its whole tail as a side effect; now that it branches
                instead, removing messages has to be asked for explicitly. */}
              {actionCommand("truncate")?.destructive && branchSessionId && (
                <MessageAction
                  tooltip={t("truncateFromTooltip")}
                  label={t("truncateFromLabel")}
                  onClick={() => setTruncateOpen(true)}
                  disabled={actionCommand("truncate")?.disabled}
                >
                  <ScissorsIcon className="size-3.5" />
                </MessageAction>
              )}

              {/* Hand a conclusion back up.
                Two shapes of the same gesture, so they share one action and one
                mechanism: a sidechat hands back to the MAIN conversation, a
                branch hands back to the conversation it was cut from. Lineage
                used to be one-way for branches — the chip could carry you to
                the parent to look, but nothing brought a finding with you.
                Deliberately not auto-sent — a conclusion reached elsewhere is
                usually worth rewording before it costs a turn up there. */}
              {handBackTargetId && (
                <MessageAction
                  tooltip={t("bringBackTooltip")}
                  label={t("bringBackLabel")}
                  onClick={handleBringBack}
                >
                  <CornerUpLeftIcon className="size-3.5" />
                </MessageAction>
              )}

              {message.role === "assistant" && ttsEnabled && (
                <ReadAloudButton
                  messageId={message.id}
                  text={extractText(message)}
                  character={speaker ?? directCharacter ?? null}
                />
              )}

              {/* Both roles: assistant siblings come from regenerating, user
                siblings from editing (which keeps the original rather than
                deleting its tail). The navigator no-ops when the message has
                no branch group, so no role gate is needed. */}
              <BranchNavigator message={message} className="mx-1" />

              {/* Self-hides unless a cross-session branch was cut here. Shows the
                fork where the decision was made, rather than only in the
                header — scrolling a long thread reveals where it diverged. */}
              {branchSessionId && (
                <BranchPointMarker sessionId={branchSessionId} messageId={message.id} />
              )}

              {message.role === "assistant" && isLastAssistant && onRegenerate && (
                <MessageAction
                  tooltip={t("regenerateTooltip")}
                  label={t("regenerateLabel")}
                  onClick={() => void onRegenerate()}
                  disabled={actionCommand("regenerate")?.disabled}
                >
                  <RefreshCcwIcon className="size-3.5" />
                </MessageAction>
              )}

              <MessageImActions message={message} text={messageText} sessionId={branchSessionId} />

              <PluginExtensionSlot
                point="chat.message.footer"
                className="flex items-center gap-1 empty:hidden"
              />
            </MessageActions>
          )}
        </MessageShell>

        {branchSessionId && (
          <BranchDialog
            sessionId={branchSessionId}
            messageId={message.id}
            open={branchOpen}
            onOpenChange={setBranchOpen}
          />
        )}

        {/* Mounted only while open, unlike BranchDialog above. Every message row
            renders one of these, and a Radix AlertDialog Root per row is enough
            overhead to disturb the message list's scroll bookkeeping (it broke
            the jump-pill's scroll-fencing tests). Same pattern as
            QuoteCardDialog below. */}
        {truncateOpen && branchSessionId && (
          <TruncateFromDialog
            sessionId={branchSessionId}
            messageId={message.id}
            open
            onOpenChange={setTruncateOpen}
          />
        )}

        {cardOpen && (
          <QuoteCardDialog
            open={cardOpen}
            onOpenChange={setCardOpen}
            role={message.role}
            authorName={speaker?.name}
            text={messageShareContent.plainText}
            model={(message as { metadata?: { model?: string } }).metadata?.model}
            timestamp={((): Date => {
              const createdAt = (message as { metadata?: { createdAt?: number } }).metadata
                ?.createdAt
              return createdAt != null ? new Date(createdAt) : nowFallback
            })()}
          />
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
    prev.directCharacter === next.directCharacter &&
    prev.onCopy === next.onCopy &&
    prev.onRegenerate === next.onRegenerate &&
    prev.onEditResend === next.onEditResend &&
    prev.onRewindFiles === next.onRewindFiles &&
    prev.projectRoot === next.projectRoot &&
    prev.messageDisplay === next.messageDisplay
)

MessageRenderer.displayName = "MessageRenderer"

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

function shouldHideMessagePart(
  part: UIMessage["parts"][number],
  display: ResolvedMessageDisplayOptions
): boolean {
  const typed = part as {
    type?: string
    state?: string
    twinDegraded?: boolean
    memoryDegraded?: boolean
  }
  if (typed.type === "reasoning") return display.reasoning === "hidden"
  if (typed.type === "sources") {
    return display.sources === "hidden" && !typed.twinDegraded && !typed.memoryDegraded
  }
  if (isToolPartType(typed.type) && display.tools === "hidden") {
    // Only successful, settled tools may disappear. Running, failed and
    // approval-sensitive states remain reachable regardless of preference.
    return typed.state === "output-available"
  }
  return false
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
  sessionId,
  mode,
  display,
  t,
  projectRoot,
}: {
  part: UIMessage["parts"][number]
  partKey: string
  isStreaming: boolean
  mentionPattern: RegExp | null
  characterById: Map<string, Character> | undefined
  messageId: string | undefined
  sessionId: string | undefined
  mode: AgentFlowMode
  display: ResolvedMessageDisplayOptions
  t: ReturnType<typeof useTranslations>
  projectRoot?: string | null
}) {
  return renderPart(
    part,
    partKey,
    isStreaming,
    mentionPattern,
    characterById,
    messageId,
    sessionId,
    mode,
    display,
    t,
    projectRoot
  )
})
MessagePart.displayName = "MessagePart"

/**
 * Build a single tool-call element for standard/detailed modes (or a compact
 * row for simplified), plus the per-call plugin action slot. Shared by the
 * inline single-tool path and the activity group's `renderChild`, so a grouped
 * tool and a standalone one are rendered by the exact same code — including the
 * plugin slot, which used to be dropped for every tool inside a simplified
 * group.
 *
 * The body itself lives in `ToolDetailBody` and is identical across modes; only
 * the chrome differs (card + header vs. one-line row). `opts.forceOpen` (from
 * the group's expand-all/collapse-all, and from `detailed`) overrides the
 * per-state default-open heuristic; `opts.expanded` / `opts.onToggle` make a
 * simplified row's open state controlled by its group.
 */
function renderToolPart(
  tp: ToolUIPart,
  key: string,
  mode: AgentFlowMode,
  opts: ToolActivityChildOptions,
  messageId: string | undefined,
  sessionId: string | undefined,
  visibility: ResolvedMessageDisplayOptions["tools"]
): React.ReactNode {
  const toolPresentation = tp as ToolUIPart & {
    title?: string
    toolName?: unknown
    toolMetadata?: { readOnlyHint?: boolean | null }
  }
  const isDynamicTool = (tp as { type: string }).type === "dynamic-tool"
  const dynamicToolName =
    typeof toolPresentation.toolName === "string" && toolPresentation.toolName.trim()
      ? toolPresentation.toolName
      : "tool"
  const displayTitle = resolveToolDisplayTitle(tp)
  const readOnlyHint = toolPresentation.toolMetadata?.readOnlyHint
  const slot = (
    <PluginExtensionSlot
      point="chat.tool-call.actions"
      className="mt-1 flex items-center gap-1 empty:hidden"
      context={{
        toolName: tp.type,
        toolState: tp.state,
        toolInput: tp.input,
        messageId,
        sessionId,
      }}
    />
  )
  const preferenceOpen =
    visibility === "expanded" ? true : visibility === "collapsed" ? false : undefined

  // Simplified mode: every tool collapses to a one-line, expandable row.
  if (mode === "simplified") {
    return (
      <React.Fragment key={key}>
        <ToolCallRow
          part={tp}
          sessionId={sessionId}
          expanded={opts.expanded}
          onToggle={opts.onToggle}
          defaultOpen={opts.forceOpen ?? preferenceOpen}
        />
        {slot}
      </React.Fragment>
    )
  }

  // A failed call and a still-running one open by default (the user needs the
  // trace / the live output); a settled success stays collapsed.
  const defaultOpen =
    opts.forceOpen ??
    preferenceOpen ??
    (mode === "detailed" || tp.state === "output-error" || tp.state === "input-available")

  // Bash keeps its own card so the terminal view owns the whole block; every
  // other tool — and a *failed* Bash, whose parsed error trace outranks the
  // terminal view — shares one generic card whose body routes in
  // `ToolDetailBody`.
  const toolEl =
    isBashToolPart(tp) && tp.state !== "output-error" ? (
      <TerminalToolPart part={tp} defaultOpen={defaultOpen} />
    ) : (
      <Tool defaultOpen={defaultOpen}>
        {isDynamicTool ? (
          <ToolHeader
            type="dynamic-tool"
            toolName={dynamicToolName}
            state={tp.state}
            title={displayTitle}
            readOnlyHint={readOnlyHint}
          />
        ) : (
          <ToolHeader
            type={tp.type}
            state={tp.state}
            title={displayTitle}
            readOnlyHint={readOnlyHint}
          />
        )}
        <ToolContent>
          <ToolDetailBody part={tp} sessionId={sessionId} />
        </ToolContent>
      </Tool>
    )

  return (
    <React.Fragment key={key}>
      {toolEl}
      {slot}
    </React.Fragment>
  )
}

function renderPart(
  part: UIMessage["parts"][number],
  key: string,
  isStreaming: boolean,
  mentionPattern: RegExp | null,
  characterById: Map<string, Character> | undefined,
  messageId: string | undefined,
  sessionId: string | undefined,
  mode: AgentFlowMode,
  display: ResolvedMessageDisplayOptions,
  t: ReturnType<typeof useTranslations>,
  projectRoot?: string | null
) {
  const type = (part as { type?: string }).type
  if (!type) return null

  if (type === "data-tool-summary") {
    return isToolUseSummaryPart(part) ? <ToolUseSummaryPart key={key} part={part} /> : null
  }

  if (type === "artifact") {
    return <ArtifactPart key={key} part={part as unknown as ArtifactPartType} />
  }

  if (type === "sources") {
    return (
      <SourcesPart
        key={key}
        part={part as unknown as SourcesPartType}
        defaultOpen={display.sources === "expanded"}
      />
    )
  }

  if (type === "grounding") {
    return <GroundingPart key={key} part={part as unknown as GroundingPartType} />
  }

  if (type === "canvas") {
    return <CanvasInlinePart key={key} part={part as unknown as CanvasInlinePartType} />
  }

  if (type === "hook-notice") {
    // Inline hook-notice part — emitted by external agents (event-to-parts).
    // The built-in agent's hook notices are whole system messages routed by
    // message-list, so they never reach renderPart.
    return <HookNoticeRow key={key} data={part as unknown as HookNoticePartData} />
  }

  if (type === "a2ui") {
    return <A2UIPart key={key} part={part as unknown as A2UIPartType} _messageId={messageId} />
  }

  if (type === DIAGNOSTICS_PART_TYPE) {
    const data = (part as { data?: unknown }).data
    if (isSlashCommandResultBlock(data)) {
      return <SlashCommandResultChip key={key} block={data} />
    }
    if (isSystemMessageBlock(data)) {
      return <DiagnosticsCard key={key} block={data as SystemMessageBlock} />
    }
    return null
  }

  if (type === "subagent") {
    // Subagent parts are rendered together as a dispatch tree at the message
    // level (see the parts map), never individually here.
    return null
  }

  if (type === "agent-team-dispatch") {
    const dp = part as unknown as AgentTeamDispatchPartType
    const fromName = characterById?.get(dp.from)?.name
    return <AgentTeamDispatchPart key={key} part={dp} fromName={fromName} mode={mode} />
  }

  if (type === "squad-run") {
    return <SquadRunPart key={key} part={part as unknown as SquadRunPartType} />
  }

  if (type === "squad-gate") {
    return <SquadGatePart key={key} part={part as unknown as SquadGatePartType} />
  }

  if (type === "text") {
    const text = (part as { text?: string }).text ?? ""
    // An empty text part carries no prose — the model emitted none between two
    // tool calls. Rendering it would add a zero-height box that still eats a
    // `gap-2` from `MessageContent`'s flex column.
    if (!text.trim()) return null
    if (mentionPattern && characterById) {
      const segments = highlightMentions(text, mentionPattern, characterById)
      return (
        <span key={key} className="whitespace-pre-wrap">
          {segments}
        </span>
      )
    }

    if (isStreaming) {
      return (
        <StreamingTextPart
          key={key}
          text={text}
          isStreaming={isStreaming}
          projectRoot={projectRoot}
          richControls={display.richControls}
          markdown={display.markdown}
        />
      )
    }

    if (text.length >= FINALIZED_MARKDOWN_LAZY_THRESHOLD) {
      return (
        <FinalizedLongTextPart
          key={key}
          text={text}
          messageId={messageId}
          projectRoot={projectRoot}
          markdown={display.markdown}
        />
      )
    }

    return (
      <MarkdownRenderer
        key={key}
        content={text}
        messageId={messageId}
        isStreaming={isStreaming}
        projectRoot={projectRoot}
        markdown={display.markdown}
        className="size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      />
    )
  }

  if (type === "reasoning") {
    const text = (part as { text?: string }).text ?? ""
    const stillStreaming = isStreaming && (part as { state?: string }).state !== "done"
    // Detailed mode keeps the reasoning expanded; simplified keeps it collapsed;
    // standard defers to the component's stream-aware auto open/close.
    const reasoningDefaultOpen =
      display.reasoning === "expanded"
        ? true
        : display.reasoning === "collapsed"
          ? false
          : mode === "detailed"
            ? true
            : mode === "simplified"
              ? false
              : undefined
    return (
      <Reasoning
        key={key}
        isStreaming={stillStreaming}
        defaultOpen={reasoningDefaultOpen}
        // Keep a finished thinking block in place instead of auto-collapsing it
        // the instant the answer streams in — the reasoning is part of the
        // transcript and should stay readable.
        closeOnFinish={false}
      >
        <ReasoningTrigger
          getThinkingMessage={(streaming, duration) => {
            if (streaming || duration === 0) return t("reasoning.streaming")
            if (duration === undefined) return t("reasoning.completed")
            return t("reasoning.completedSeconds", { duration })
          }}
        />
        <ReasoningContent
          streamdownProps={{
            className: cn(
              "typeset typeset-chat",
              display.markdown.codeWrap && "[&_pre]:whitespace-pre-wrap"
            ),
            components: createStreamingComponents(projectRoot, stillStreaming),
            controls: { table: false },
            isAnimating: stillStreaming,
            // ADR-0127: reasoning bodies honour the same markdown knobs.
            lineNumbers: display.markdown.codeLineNumbers,
            mode: stillStreaming ? "streaming" : "static",
            plugins: selectStreamdownPlugins(display.markdown),
            rehypePlugins: chatStreamdownRehypePlugins,
            urlTransform: chatMarkdownUrlTransform,
          }}
        >
          {text}
        </ReasoningContent>
      </Reasoning>
    )
  }

  if (type === "data-commentary") {
    const data = (part as { data?: { text?: string } }).data
    const text = data?.text ?? ""
    if (!text.trim()) return null
    return (
      <div
        key={key}
        role="status"
        aria-live="polite"
        className="border-muted-foreground/30 text-muted-foreground border-l-2 pl-3 text-sm"
      >
        <MarkdownRenderer
          content={text}
          messageId={messageId}
          isStreaming={isStreaming}
          projectRoot={projectRoot}
          markdown={display.markdown}
          className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
        />
      </div>
    )
  }

  if (type === "file") {
    const url = (part as { url?: string }).url
    const mediaType = (part as { mediaType?: string }).mediaType
    const filename = (part as { filename?: string }).filename

    if (url && mediaType?.startsWith("image/")) {
      return (
        <MessageImageGallery
          key={key}
          items={[
            {
              id: key,
              src: url,
              alt: filename ?? t("attachmentAlt"),
              filename,
            },
          ]}
        />
      )
    }

    // A document the user attached: the model got its extracted text, and that
    // text rides along on the part (there is no `url` — the original binary is
    // deliberately not persisted). Render it as a collapsed file card instead
    // of spilling the whole document into the bubble.
    const attachedText = (part as { text?: string }).text
    if (!url && attachedText) {
      return (
        <AttachmentTextCard
          key={key}
          filename={filename ?? t("attachmentAlt")}
          mediaType={mediaType}
          text={attachedText}
        />
      )
    }

    if (!url) return null

    // Non-image file: inline preview for text/code/pdf, download link otherwise.
    return <FilePartPreview key={key} url={url} mediaType={mediaType} filename={filename} />
  }

  // Special-case Claude's TodoWrite tool: render as a structured task list.
  // The sidecar coreFiles suite names its tool exactly "TodoWrite" so the
  // ai-sdk path lands here too; the namespaced form covers the Anthropic
  // escape-hatch registration.
  if (type === "tool-TodoWrite" || type === "tool-mcp__cognia-tools__TodoWrite") {
    const tp = part as ToolUIPart
    const todos = parseTodoInput(tp.input)
    if (todos) {
      return <TodoList key={key} todos={todos} />
    }
    // Falls through to generic Tool rendering below.
  }

  // Plugin-contributed part types — checked before the generic tool fallback
  // so a plugin can override custom types it owns, but AFTER the host's own
  // hard-coded parts so plugins cannot shadow `artifact` / `a2ui` / etc.
  const pluginEntry =
    typeof type === "string" && !isToolPartType(type) ? getMessagePartRenderer(type) : undefined
  if (pluginEntry) {
    const PluginRenderer = pluginEntry.component
    return (
      <React.Fragment key={key}>
        <PluginSurface
          pluginId={pluginEntry.pluginId}
          surfaceId={`message-renderer:${pluginEntry.type}`}
          formFactor="block"
        >
          <PluginRenderer part={part} messageId={messageId} isStreaming={isStreaming} />
        </PluginSurface>
        {/* UI companion to the `provider.message-renderer` runtime point: */}
        {/* plugins can mount per-part actions beneath any rendered part. */}
        <PluginExtensionSlot
          point="chat.message-part.actions"
          className="mt-1 flex items-center gap-1 empty:hidden"
          context={{ partType: pluginEntry.type, messageId, sessionId, isStreaming }}
        />
      </React.Fragment>
    )
  }

  // `dynamic-tool` is the AI SDK shape for a tool the client never declared
  // statically — imported transcripts and CLI handoff carry it, and every
  // other consumer (grouping, summaries, exports, ToolHeader/ToolBody) already
  // treats it as a tool call. Route it through the same renderer instead of
  // dropping it into the unknown-part card.
  if (isToolPartType(type)) {
    const tp = part as ToolUIPart
    // Delegate to the shared tool renderer (mode-aware: simplified row vs.
    // standard/detailed card), which also appends the per-call plugin slot.
    return renderToolPart(tp, key, mode, {}, messageId, sessionId, display.tools)
  }

  // AI SDK structural/control parts carry no visible content — render nothing
  // (don't fall through to the unknown-part card and spam a box per step).
  if (typeof type === "string" && SILENT_CONTROL_PART_TYPES.has(type)) return null

  // gap1 — unknown non-tool part: surface a debuggable fallback card instead
  // of silently dropping it (mirrors the always-visible unknown-`tool-` card).
  return <UnknownPartCard key={key} part={part} />
}
