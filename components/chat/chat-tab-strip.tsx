"use client"

/**
 * Tab strip for the concurrent-chat workspace. Lists every *open* session as a
 * closeable tab, shows a per-session live status dot (streaming / error /
 * awaiting-approval), and exposes a split-view toggle so two sessions can be
 * watched side by side. Active-tab + split state live in `useChatStore`; this
 * component is the view over them.
 */

import { useTranslations } from "next-intl"
import { Loader2, X, Columns2, Plus, AlertCircle, Clock, FileDiff } from "lucide-react"
import { cn } from "@/lib/utils"
import { useSessionArtifactSummary } from "@/hooks/artifacts/use-session-artifacts"
import { useSessionStatus } from "@/stores/chat"
import type { ChatStatus } from "@/stores/chat/chat-store"

export interface ChatTabInfo {
  id: string
  title: string
}

interface ChatTabStripProps {
  tabs: readonly ChatTabInfo[]
  activeId: string | null
  splitId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onToggleSplit: (id: string) => void
  onNew: () => void
}

/**
 * What this conversation is holding in the right rail.
 *
 * The rail follows `activeSessionId` alone, so in split view everything the
 * other pane produced was invisible: no artifact tab, no dock expansion, and
 * `useDockAttentionSignal` ignores background sessions on purpose (an artifact
 * landing elsewhere must not throw the dock over the conversation you are
 * reading). Selecting the tab is already the way to bring the rail across —
 * this only makes it visible that there is a reason to.
 *
 * Suppressed on the active tab, whose artifacts are the ones already on screen.
 */
function TabArtifactBadge({ sessionId, active }: { sessionId: string; active: boolean }) {
  const t = useTranslations("chat.concurrent")
  const { openCount, pendingReviewCount } = useSessionArtifactSummary(sessionId)
  if (active || openCount === 0) return null
  // A pending proposal is a request for the user's decision, so it outranks a
  // plain count and takes the accent colour.
  const pending = pendingReviewCount > 0
  return (
    <span
      data-testid={`chat-tab-artifacts-${sessionId}`}
      data-pending-review={pending || undefined}
      aria-label={
        pending
          ? t("artifactsPendingReview", { count: openCount, pending: pendingReviewCount })
          : t("artifactsOpen", { count: openCount })
      }
      className={cn(
        "flex shrink-0 items-center gap-0.5 rounded-sm px-1 text-[9px] tabular-nums",
        pending ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
      )}
    >
      <FileDiff className="size-2.5" aria-hidden />
      {openCount}
    </span>
  )
}

/** Live per-session status indicator for a tab. */
function TabStatusDot({ sessionId }: { sessionId: string }) {
  const t = useTranslations("chat.concurrent")
  const status: ChatStatus = useSessionStatus(sessionId)
  if (status === "streaming") {
    return (
      <Loader2 className="size-3 shrink-0 animate-spin text-primary" aria-label={t("streaming")} />
    )
  }
  if (status === "awaiting_approval") {
    return <Clock className="size-3 shrink-0 text-amber-500" aria-label={t("awaitingApproval")} />
  }
  if (status === "error") {
    return <AlertCircle className="size-3 shrink-0 text-destructive" aria-label={t("errored")} />
  }
  return null
}

export function ChatTabStrip({
  tabs,
  activeId,
  splitId,
  onSelect,
  onClose,
  onToggleSplit,
  onNew,
}: ChatTabStripProps) {
  const t = useTranslations("chat.concurrent")
  // A single open tab needs no strip — the workspace renders the lone pane.
  if (tabs.length < 2 && !splitId) return null
  const canSplit = tabs.length >= 2

  return (
    <div
      role="tablist"
      aria-label={t("openConversations")}
      className="flex items-center gap-1 overflow-x-auto border-b bg-muted/30 px-1.5 py-1"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeId
        const isSplit = tab.id === splitId
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                onSelect(tab.id)
              }
            }}
            className={cn(
              "group flex max-w-[14rem] shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs",
              isActive
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-background/60",
              isSplit && !isActive && "ring-1 ring-primary/40"
            )}
            data-testid={`chat-tab-${tab.id}`}
          >
            <TabStatusDot sessionId={tab.id} />
            <span className="truncate">{tab.title || t("untitled")}</span>
            <TabArtifactBadge sessionId={tab.id} active={isActive} />
            <button
              type="button"
              aria-label={t("closeTab", { title: tab.title || t("untitled") })}
              className="ml-0.5 rounded p-0.5 opacity-60 hover:bg-muted hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation()
                onClose(tab.id)
              }}
            >
              <X className="size-3" aria-hidden />
            </button>
          </div>
        )
      })}

      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          aria-label={splitId ? t("exitSplit") : t("splitView")}
          aria-pressed={Boolean(splitId)}
          disabled={!canSplit}
          onClick={() => activeId && onToggleSplit(activeId)}
          className={cn(
            "rounded p-1 text-muted-foreground hover:bg-background disabled:opacity-40",
            splitId && "bg-background text-foreground"
          )}
        >
          <Columns2 className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={t("newTab")}
          onClick={onNew}
          className="rounded p-1 text-muted-foreground hover:bg-background"
        >
          <Plus className="size-3.5" aria-hidden />
        </button>
      </div>
    </div>
  )
}
