"use client"

/**
 * AttentionPanel — the Control Center: one status-bar surface for every
 * pending item across chat tool approvals, agent-team HITL gates, and
 * external fleet agents. Modeled on `components/desktop/job-center-panel.tsx`
 * (Sheet + badge trigger).
 *
 * Actions are honest about ownership: chat/team rows NAVIGATE to the surface
 * that owns the answer (the pane's ToolApprovalDialog / the workspace's
 * GateModalsHost), fleet permission rows answer inline via the same
 * `IslandPermissionActions` the island uses (window-agnostic invoke), and
 * stale rows offer only Dismiss.
 */

import { useRouter } from "next/navigation"
import { BellRingIcon, ExternalLinkIcon, FileTextIcon, TerminalIcon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { useAttentionItems, useAttentionCount } from "@/hooks/attention/use-attention"
import { useChatStore } from "@/stores/chat/chat-store"
import { usePendingGatesStore } from "@/stores/agent/pending-gates-store"
import { useUIStore } from "@/stores/ui/ui-store"
import { IslandPermissionActions } from "@/components/fleet/island-permission-actions"
import { activityLine } from "@/lib/fleet/format"
import { fleetFocusTerminal, fleetRevealTranscript } from "@/lib/tauri/fleet"
import type { AttentionItem } from "@/lib/attention/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { cn } from "@/lib/utils"

function AttentionRow({ item, onNavigated }: { item: AttentionItem; onNavigated: () => void }) {
  const t = useTranslations("attention")
  const router = useRouter()
  const setSelectedGuild = useUIStore((s) => s.setSelectedGuild)

  const openChatSession = () => {
    if (!item.sessionId) return
    useChatStore.getState().setActiveSession(item.sessionId)
    setSelectedGuild({ kind: "dm" })
    router.push("/")
    onNavigated()
  }
  const openTeamWorkspace = () => {
    router.push(
      item.teamId
        ? `/agent-teams/workspace?teamId=${encodeURIComponent(item.teamId)}`
        : "/agent-teams/workspace"
    )
    onNavigated()
  }
  const dismiss = () => {
    if (item.source === "chat" && item.approval) {
      useChatStore.getState().clearApproval(item.approval.requestId, item.sessionId)
    } else if (item.source === "team" && item.gate) {
      usePendingGatesStore.getState().close(item.gate.key)
    }
  }

  return (
    <div
      data-testid={`attention-row-${item.id}`}
      className={cn(
        "flex items-start gap-2 rounded-md border p-2 text-sm",
        item.stale && "opacity-60"
      )}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-1.5">
          <Badge variant="outline" className="shrink-0 text-[10px]">
            {t(`source.${item.source}`)}
          </Badge>
          <span className="truncate font-medium">{item.title}</span>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {item.stale
            ? t("interrupted")
            : (item.detail ??
              (item.fleetSession
                ? (activityLine(item.fleetSession) ?? t(`kind.${item.kind}`))
                : t(`kind.${item.kind}`)))}
        </p>
        {!item.stale &&
          item.kind === "fleet-permission" &&
          item.fleetSession?.pendingPermission && (
            <IslandPermissionActions
              pending={item.fleetSession.pendingPermission}
              className="mt-1"
            />
          )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!item.stale && item.source === "chat" && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={t("openOwner")}
            onClick={openChatSession}
          >
            <ExternalLinkIcon className="size-3.5" />
          </Button>
        )}
        {!item.stale && item.source === "team" && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={t("openOwner")}
            onClick={openTeamWorkspace}
          >
            <ExternalLinkIcon className="size-3.5" />
          </Button>
        )}
        {!item.stale &&
          item.source === "fleet" &&
          item.fleetSession?.capabilities.openTranscript &&
          item.fleetSession?.transcriptPath && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={t("revealTranscript")}
              data-testid={`attention-reveal-transcript-${item.id}`}
              onClick={() => {
                const path = item.fleetSession?.transcriptPath
                if (path) void fleetRevealTranscript(path)
              }}
            >
              <FileTextIcon className="size-3.5" />
            </Button>
          )}
        {!item.stale &&
          item.source === "fleet" &&
          item.fleetSession?.capabilities.focusTerminal && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={t("focusTerminal")}
              data-testid={`attention-focus-terminal-${item.id}`}
              onClick={() => {
                const s = item.fleetSession
                if (s) void fleetFocusTerminal(s.agent, s.sessionId)
              }}
            >
              <TerminalIcon className="size-3.5" />
            </Button>
          )}
        {item.stale && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={t("dismiss")}
            onClick={dismiss}
          >
            <XIcon className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  )
}

export function AttentionPanel() {
  const t = useTranslations("attention")
  const items = useAttentionItems()
  const count = useAttentionCount()

  // Nothing to attend to means no trigger: it used to sit in the status bar all
  // day showing a bell with no number. Self-gating also lets the surviving
  // affordance stay loud (amber + pulse + count) instead of being flattened
  // into a neighbouring menu to save space.
  //
  // Gated on `items`, NOT `count` — `liveAttentionCount` excludes stale rows,
  // and those still need their Dismiss. Hiding on a zero count would strand a
  // list of dead approvals with no way to open the sheet that clears them.
  if (items.length === 0) return null

  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          data-testid="attention-trigger"
          aria-label={t("badgeAria", { count })}
          className={cn(
            "relative flex h-6 items-center gap-1 rounded px-1.5 text-xs text-muted-foreground",
            "hover:bg-accent hover:text-accent-foreground"
          )}
        >
          <BellRingIcon className={cn("size-3.5", count > 0 && "animate-pulse text-amber-500")} />
          {count > 0 && (
            <span data-testid="attention-count" className="font-medium text-amber-600">
              {count}
            </span>
          )}
        </button>
      </SheetTrigger>
      <SheetContent side="right" className="flex w-96 flex-col gap-3 sm:max-w-96">
        <SheetHeader className="pb-0">
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("description")}</SheetDescription>
        </SheetHeader>
        {items.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BellRingIcon />
              </EmptyMedia>
              <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
              <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-2 pr-3">
              {items.map((item) => (
                <AttentionRow key={item.id} item={item} onNavigated={() => {}} />
              ))}
            </div>
          </ScrollArea>
        )}
      </SheetContent>
    </Sheet>
  )
}
