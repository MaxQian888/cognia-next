"use client"

import { forwardRef, memo, useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { AlertCircleIcon, Loader2Icon, MessageCircleIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AgentTeamMessage } from "@/types/agent/agent-team"
import {
  TEAM_MESSAGE_METADATA_KEYS,
  type ToolCallEntry,
} from "@/lib/agent-team/team-runtime-dispatcher"
import type { MentionTarget } from "@/lib/agent-team/runtime-targets"
import { senderColor } from "./sender-color"
import { RuntimeBadge } from "./runtime-badge"
import { TeamMentionChips } from "./team-mention-chips"
import { TeamComposer } from "./team-composer"
import { ToolCallList } from "./tool-call-card"
import { TokenUsageLine } from "./token-usage-line"
import { MessageActionsMenu } from "./message-actions-menu"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { stripAgentBlocks } from "@/lib/agent-team/agent-blocks"
import type { RuntimeAvailabilityMap } from "@/lib/agent-team/use-runtime-availability"
import type { ComposerHandle } from "@/components/chat/composer"
import { TEAM_USER_SENDER_ID } from "@/types/agent/agent-team"
import type { TeammateRuntime } from "@/types/agent/agent-team"
import type { SubAgentTokenUsage } from "@/types/agent/sub-agent"
import type { ProjectFileReference } from "@/lib/files/project-file-reference"

/* ------------------------------------------------------------------ */
/*  Border color per message type                                       */
/* ------------------------------------------------------------------ */

function typeBorderColor(type: string): string {
  switch (type) {
    case "broadcast":
      return "border-l-blue-500"
    case "direct":
      return "border-l-green-500"
    case "plan_approval":
    case "plan_feedback":
      return "border-l-amber-500"
    case "task_update":
      return "border-l-purple-500"
    case "result_share":
      return "border-l-emerald-500"
    case "shutdown":
      return "border-l-red-500"
    case "consensus":
      return "border-l-cyan-500"
    default:
      return "border-l-muted-foreground/30"
  }
}

function formatTimestamp(ts: Date): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function readRuntimeFromMetadata(msg: AgentTeamMessage): TeammateRuntime | null {
  const v = msg.metadata?.[TEAM_MESSAGE_METADATA_KEYS.RUNTIME]
  if (typeof v !== "string") return null
  if (
    v === "claude" ||
    v === "codex" ||
    v === "claude-code" ||
    v === "gemini-cli" ||
    v === "cursor-cli"
  ) {
    return v
  }
  return null
}

function readToolCalls(msg: AgentTeamMessage): ToolCallEntry[] | null {
  const v = msg.metadata?.[TEAM_MESSAGE_METADATA_KEYS.TOOL_CALLS]
  return Array.isArray(v) ? (v as ToolCallEntry[]) : null
}

function readTokenUsage(msg: AgentTeamMessage): Partial<SubAgentTokenUsage> | null {
  const v = msg.metadata?.[TEAM_MESSAGE_METADATA_KEYS.TOKEN_USAGE]
  if (v && typeof v === "object") return v as Partial<SubAgentTokenUsage>
  return null
}

function isStreaming(msg: AgentTeamMessage): boolean {
  return msg.metadata?.[TEAM_MESSAGE_METADATA_KEYS.STREAMING] === true
}

function isErrored(msg: AgentTeamMessage): boolean {
  return msg.metadata?.[TEAM_MESSAGE_METADATA_KEYS.ERROR] === true
}

/**
 * User messages and streaming-in-progress placeholders render as plain text
 * (markdown rendering on a partial token stream produces flicker). Completed
 * agent messages get the full MarkdownRenderer treatment so code blocks,
 * lists, tables, etc. display properly.
 */
function renderMessageBody(
  msg: AgentTeamMessage,
  streaming: boolean,
  projectRoot?: string,
  onOpenProjectFile?: (target: ProjectFileReference) => void
) {
  const isFromUser = msg.senderId === TEAM_USER_SENDER_ID
  // Hide teammate-to-teammate operational instructions wrapped in <info_for_agent>;
  // the full text stays in the store for the recipient's context.
  const visible = stripAgentBlocks(msg.content)
  if (isFromUser || streaming || !visible) {
    return <p className="whitespace-pre-wrap text-xs leading-relaxed">{visible}</p>
  }
  return (
    <div className="text-xs leading-relaxed">
      <MarkdownRenderer
        content={visible}
        messageId={msg.id}
        projectRoot={projectRoot}
        onOpenProjectFile={onOpenProjectFile}
        enableMermaid
        enableMath
        enableDiff
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */

interface ChatMessageItemProps {
  msg: AgentTeamMessage
  /** Stagger-animate only the last few new messages. */
  animate: boolean
  /** 0-based position within the animated tail window (drives the delay). */
  animationSlot: number
  onRetry?: AgentTeamChatProps["onRetry"]
  onDelete?: AgentTeamChatProps["onDelete"]
  projectRoot?: string
  onOpenProjectFile?: (target: ProjectFileReference) => void
}

/**
 * A single chat message card. Memoised so that streaming deltas — which
 * replace only the streaming message's object in the store — re-render just
 * that card instead of every MarkdownRenderer in the history.
 */
const ChatMessageItem = memo(function ChatMessageItem({
  msg,
  animate,
  animationSlot,
  onRetry,
  onDelete,
  projectRoot,
  onOpenProjectFile,
}: ChatMessageItemProps) {
  const t = useTranslations("agentTeamsWorkspace.chat")
  const tMsg = useTranslations("agentTeamsWorkspace.chat.messageTypes")
  const runtime = readRuntimeFromMetadata(msg)
  const streaming = isStreaming(msg)
  const errored = isErrored(msg)
  const toolCalls = readToolCalls(msg)
  const tokenUsage = readTokenUsage(msg)
  return (
    <motion.div
      initial={animate ? { opacity: 0, y: 4 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.15,
        ease: "easeOut",
        delay: animate ? Math.min(animationSlot * 0.03, 0.12) : 0,
      }}
    >
      <Card
        className={`group space-y-1 border-l-2 p-3 ${typeBorderColor(msg.type)} ${
          streaming ? "ring-1 ring-primary/20" : ""
        } ${errored ? "ring-1 ring-destructive/40" : ""}`}
        data-testid={`chat-msg-${msg.id}`}
        data-streaming={streaming ? "true" : "false"}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span
              className="flex size-6 items-center justify-center rounded-full text-[10px] font-medium"
              style={{ backgroundColor: senderColor(msg.senderName), color: "white" }}
              aria-hidden
            >
              {msg.senderName.charAt(0).toUpperCase()}
            </span>
            <span className="text-xs font-medium">{msg.senderName}</span>
            {runtime && <RuntimeBadge runtime={runtime} iconOnly />}
            <Badge variant="outline" className="text-[9px]">
              {tMsg(msg.type as never) ?? msg.type}
            </Badge>
            {errored && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" className="text-destructive" aria-label={t("errorReason")}>
                    <AlertCircleIcon className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs text-xs">{t("errorGeneric")}</TooltipContent>
              </Tooltip>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="font-mono text-[10px] text-muted-foreground">
              {formatTimestamp(msg.timestamp)}
            </span>
            {!streaming && (onRetry || onDelete) && (
              <span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                <MessageActionsMenu message={msg} onRetry={onRetry} onDelete={onDelete} />
              </span>
            )}
          </div>
        </div>
        {toolCalls && toolCalls.length > 0 && <ToolCallList calls={toolCalls} />}
        {renderMessageBody(msg, streaming, projectRoot, onOpenProjectFile)}
        {streaming && (
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <Loader2Icon className="size-3 animate-spin" />
            <span>{t("streaming")}</span>
          </div>
        )}
        {!streaming && tokenUsage && <TokenUsageLine usage={tokenUsage} />}
        {msg.structuredPayload && (
          <div className="rounded bg-muted/50 p-2 text-[10px] text-muted-foreground">
            <span className="font-medium">{t("structuredPayload")}:</span>{" "}
            {JSON.stringify(msg.structuredPayload).slice(0, 200)}
          </div>
        )}
      </Card>
    </motion.div>
  )
})

/* ------------------------------------------------------------------ */

export interface AgentTeamChatProps {
  teamId: string
  messages: AgentTeamMessage[]
  /**
   * When provided, renders the team composer + quick mention chips below
   * the message list. `onSend(rawText)` is invoked with the raw textarea
   * content; the workspace page parses the leading `@<name>` and routes
   * it via `dispatchTeamMention`.
   */
  mentionables?: readonly MentionTarget[]
  onSend?: (rawText: string) => void | Promise<void>
  /**
   * Stop the current streaming response. Called when the user clicks the
   * stop button in the streaming banner. Should abort the active dispatch
   * and call `externalAgent.cancel()` for ACP runtimes.
   */
  onStop?: () => void | Promise<void>
  /** True while any dispatch is in-flight; surfaces a streaming banner. */
  isSending?: boolean
  /** Optional runtime-availability map; chips dim + warn when not ready. */
  availability?: RuntimeAvailabilityMap
  /** Re-dispatch a previous prompt to the same target. */
  onRetry?: (params: {
    targetId: string
    prompt: string
    messageId: string
  }) => void | Promise<void>
  /** Remove a message from the chat. */
  onDelete?: (messageId: string) => void | Promise<void>
  /** Root used to resolve relative file links in completed agent messages. */
  projectRoot?: string
  /** Owner override for switching to and mounting the project editor. */
  onOpenProjectFile?: (target: ProjectFileReference) => void
  /**
   * Extra classes for the root container. The workspace passes
   * `flex-1 min-h-0` so the chat fills the tab height (message list scrolls
   * internally, composer pinned at the bottom) instead of being a
   * fixed-height box that leaves the lower half of the pane empty.
   */
  className?: string
}

export const AgentTeamChat = forwardRef<ComposerHandle, AgentTeamChatProps>(function AgentTeamChat(
  {
    teamId: _teamId,
    messages,
    mentionables,
    onSend,
    onStop,
    isSending,
    availability,
    onRetry,
    onDelete,
    projectRoot,
    onOpenProjectFile,
    className,
  },
  composerRef
) {
  const t = useTranslations("agentTeamsWorkspace.chat")
  const prefersReducedMotion = useReducedMotion()
  const bottomRef = useRef<HTMLDivElement>(null)
  const localComposerRef = useRef<ComposerHandle | null>(null)

  // Track total streaming text length so we re-scroll as deltas land. Using a
  // hash of (count, last-msg content length, last-msg streaming flag) keeps
  // the dependency cheap to compute and stable when nothing actually changes.
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null
  const scrollHash = `${messages.length}:${lastMsg?.id ?? ""}:${
    lastMsg?.content.length ?? 0
  }:${lastMsg ? isStreaming(lastMsg) : 0}`

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [scrollHash])

  const showComposer = !!onSend && !!mentionables
  const handleChipPick = (target: MentionTarget) => {
    const ref =
      (composerRef as React.RefObject<ComposerHandle | null> | null)?.current ??
      localComposerRef.current
    ref?.insertMention(target.name)
  }

  return (
    <div
      className={cn("flex min-h-0 w-full flex-col gap-3", className)}
      data-testid="agent-team-chat-root"
    >
      {messages.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-md border bg-muted/30 px-4 py-8">
          <Empty>
            <EmptyMedia variant="icon">
              <MessageCircleIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>{t("empty")}</EmptyTitle>
            </EmptyHeader>
            {showComposer && (
              <p className="mt-1 text-center text-xs text-muted-foreground">{t("emptyHint")}</p>
            )}
          </Empty>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-2" data-testid="workspace-chat">
            {messages.map((msg, index) => {
              // Only stagger the last few new messages — established history
              // would otherwise flicker on every render.
              const shouldAnimate = !prefersReducedMotion && index >= messages.length - 5
              return (
                <ChatMessageItem
                  key={msg.id}
                  msg={msg}
                  animate={shouldAnimate}
                  animationSlot={index - Math.max(messages.length - 5, 0)}
                  onRetry={onRetry}
                  onDelete={onDelete}
                  projectRoot={projectRoot}
                  onOpenProjectFile={onOpenProjectFile}
                />
              )
            })}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>
      )}
      {showComposer && (
        <div className="shrink-0 space-y-2">
          <TeamMentionChips
            targets={mentionables!}
            onPick={handleChipPick}
            availability={availability}
          />
          <TeamComposer
            ref={(node) => {
              localComposerRef.current = node
              if (typeof composerRef === "function") composerRef(node)
              else if (composerRef) composerRef.current = node
            }}
            mentionables={mentionables!}
            onSend={onSend!}
            onStop={onStop}
            isStreaming={isSending}
          />
        </div>
      )}
    </div>
  )
})
