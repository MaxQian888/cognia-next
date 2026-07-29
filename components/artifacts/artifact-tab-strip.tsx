"use client"

/**
 * ArtifactTabStrip — the open-artifact tabs that sit at the left of the dock's
 * workbench header.
 *
 * It carries no layout state of its own. Each artifact's workbench scope is
 * already keyed `…::artifact:{id}`, so switching tabs restores that artifact's
 * own active panel and width for free.
 *
 * Lives *inside* the existing header rather than above it: the dock is often
 * only ~34% of the window, and a third horizontal band would cost content room
 * the panels need more.
 */

import { useState } from "react"
import { CornerUpLeftIcon, MessageSquarePlusIcon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { wholeArtifactSelection } from "@/lib/artifacts/format-selection-context"
import { cn } from "@/lib/utils"
import { MotionSelectionIndicator } from "@/components/chat/motion/motion-reveal"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useActiveArtifactId, useOpenArtifactIds } from "@/hooks/artifacts/use-session-artifacts"
import { useChatStore } from "@/stores/chat"
import { useChatViewportStore } from "@/stores/chat/chat-viewport-store"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { getArtifactTypeIcon } from "./artifact-icons"

/**
 * Ids worth showing as tabs. An id can outlive its artifact (LRU eviction on
 * persist, or a delete in another tab), and a lone tab is just a label for the
 * panel already on screen — so below two, there is nothing to show.
 *
 * Hosts call this to decide whether to hand the strip to the workbench header
 * at all: passing an element that renders `null` would still read as "the host
 * occupied this slot" and needlessly displace the panel's own tabs.
 */
export function useOpenArtifactTabs(): string[] {
  const openArtifactIds = useOpenArtifactIds()
  const artifacts = useArtifactStore((state) => state.artifacts)
  const tabs = openArtifactIds.filter((id: string) => artifacts[id])
  return tabs.length < 2 ? EMPTY_TABS : tabs
}

const EMPTY_TABS: string[] = []

export function ArtifactTabStrip({ className }: { className?: string }) {
  const t = useTranslations("artifacts")
  const tJump = useTranslations("chat.jump")
  const artifacts = useArtifactStore((state) => state.artifacts)
  const activeArtifactId = useActiveArtifactId()
  const setActiveArtifact = useArtifactStore((state) => state.setActiveArtifact)
  const closeArtifact = useArtifactStore((state) => state.closeArtifact)
  const reorderOpenArtifact = useArtifactStore((state) => state.reorderOpenArtifact)
  const tabs = useOpenArtifactTabs()
  const [draggedId, setDraggedId] = useState<string | null>(null)
  // Which turn the conversation is scrolled to, so a tab can point back at the
  // message that produced it. Published per *turn change*, not per scroll
  // frame — see `chatViewportStore`.
  const activeTurnMessageIds = useChatViewportStore((state) => state.activeTurnMessageIds)
  const jumpToMessage = useChatViewportStore((state) => state.jumpToMessage)
  // Staging a *whole* artifact reuses the selection pipeline wholesale: the
  // composer already renders one chip per ref and folds them into the prompt on
  // send. Only sub-ranges could be referenced before, via the preview's
  // selection button — there was no way to say "this artifact" as a whole.
  const addContextSelection = useChatStore((state) => state.addContextSelection)
  // Scopes the sliding selection indicator. Two strips can be mounted at once
  // (the desktop dock plus the mobile sheet behind it); a shared group id would
  // let the highlight fly between them.
  const sessionKey = useChatStore((state) => state.activeSessionId) ?? "none"

  // The jump can legitimately fail — the source message may have been compacted
  // away or belong to a session that is no longer open. That used to be a
  // silent no-op, so the affordance looked broken rather than inapplicable.
  const goToSource = (messageId: string) => {
    if (!jumpToMessage) return
    if (!jumpToMessage(messageId, undefined, { align: "center" })) {
      toast.error(tJump("notFound"))
    }
  }

  if (tabs.length === 0) return null

  return (
    <div
      role="tablist"
      aria-label={t("dock.openArtifacts")}
      data-testid="artifact-tab-strip"
      className={cn("flex min-w-0 items-center gap-0.5 overflow-x-auto", className)}
    >
      {tabs.map((id, index) => {
        const artifact = artifacts[id]
        const active = id === activeArtifactId
        // The conversation is scrolled to the turn this artifact came out of.
        const inView = activeTurnMessageIds.includes(artifact.messageId)
        return (
          <ContextMenu key={id}>
            <ContextMenuTrigger asChild>
              <div
                draggable
                data-testid={`artifact-tab-item-${id}`}
                data-source-in-view={inView || undefined}
                onDragStart={(event) => {
                  setDraggedId(id)
                  event.dataTransfer.effectAllowed = "move"
                }}
                onDragEnd={() => setDraggedId(null)}
                onDragOver={(event) => {
                  // Required, or the browser refuses the drop.
                  if (draggedId && draggedId !== id) event.preventDefault()
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  if (draggedId && draggedId !== id) reorderOpenArtifact(draggedId, index)
                  setDraggedId(null)
                }}
                className={cn(
                  "group relative flex min-w-0 shrink items-center gap-1 rounded-md pr-0.5 pl-1.5",
                  !active && "hover:bg-accent/50",
                  // A ring rather than a fill: "selected" is already spending the
                  // background, and these two are independent — the tab you are
                  // reading is often not the one the conversation is scrolled to.
                  inView && !active && "ring-1 ring-primary/40 ring-inset",
                  draggedId === id && "opacity-50"
                )}
              >
                {/* Keyed on the session: two docks (a split pane, the mobile
                    sheet behind the desktop one) must not share an indicator. */}
                <MotionSelectionIndicator
                  groupId={`artifact-tabs-${sessionKey}`}
                  active={active}
                  className="absolute inset-0 rounded-md bg-secondary"
                />
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-testid={`artifact-tab-${id}`}
                  // `relative` so it paints above the absolutely-positioned
                  // selection indicator rather than under it.
                  className="relative flex min-w-0 items-center gap-1.5 py-1 text-xs"
                  title={
                    jumpToMessage ? t("dock.tabHint", { title: artifact.title }) : artifact.title
                  }
                  onClick={() => setActiveArtifact(id)}
                  // Every artifact records the message it came out of, but nothing
                  // could act on it — the link ran one way only. Double-click is
                  // the editor convention for "reveal the source of this tab".
                  onDoubleClick={() => goToSource(artifact.messageId)}
                  // Browser/editor convention: middle-click closes the tab.
                  onAuxClick={(event) => {
                    if (event.button === 1) closeArtifact(id)
                  }}
                >
                  <span className="shrink-0 text-muted-foreground">
                    {getArtifactTypeIcon(artifact.type)}
                  </span>
                  <span className="max-w-28 truncate">{artifact.title}</span>
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("dock.closeTab", { title: artifact.title })}
                  data-testid={`artifact-tab-close-${id}`}
                  // Hover-revealed on mouse; always visible on coarse pointers,
                  // where there is no hover to reveal it.
                  className="relative size-5 shrink-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
                  onClick={() => closeArtifact(id)}
                >
                  <XIcon className="size-3" />
                </Button>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                data-testid={`artifact-tab-reference-${id}`}
                onSelect={() => addContextSelection(wholeArtifactSelection({ ...artifact, id }))}
              >
                <MessageSquarePlusIcon className="size-4" />
                {t("dock.referenceInChat")}
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!jumpToMessage}
                data-testid={`artifact-tab-source-${id}`}
                onSelect={() => goToSource(artifact.messageId)}
              >
                <CornerUpLeftIcon className="size-4" />
                {t("dock.goToSource")}
              </ContextMenuItem>
              <ContextMenuItem
                data-testid={`artifact-tab-close-item-${id}`}
                onSelect={() => closeArtifact(id)}
              >
                <XIcon className="size-4" />
                {t("dock.closeTabMenuItem")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )
      })}
    </div>
  )
}

export default ArtifactTabStrip
