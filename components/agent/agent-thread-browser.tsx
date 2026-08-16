"use client"

/**
 * Global agent thread browser (ADR-0108) — the status bar's `agentThreads`
 * segment.
 *
 * Projects every hidden subagent session under its parent's lineage so a user
 * can find, open, or promote a child that never appears in the chat sidebar.
 * Opening a thread navigates across project and task; promoting a completed
 * child clones its transcript into a new primary snapshot through the existing
 * branch semantics (`lib/agent/thread-browser.ts`). Live ownership is never
 * transferred, and a running child cannot be promoted.
 *
 * It lives in the status bar because it is ambient, cross-project state — the
 * same shelf as notifications / attention / jobs — and is user-customizable
 * through the bar's layout like every other segment (`@/types/shell/bars`).
 * Like the terminal segment it returns `null` while there is nothing to browse:
 * a workspace that never spawned a subagent should not carry a permanent
 * "Threads (0)" control.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { BotIcon, CopyPlusIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { listAgentThreadSessions } from "@/lib/db/sessions"
import {
  buildAgentThreadForest,
  promoteSubagentSession,
  type AgentThreadNode,
} from "@/lib/agent/thread-browser"
import { cn } from "@/lib/utils"
import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"
import { useUIStore } from "@/stores/ui/ui-store"

function AgentThreadRow({
  node,
  depth,
  onOpen,
  onPromote,
}: {
  node: AgentThreadNode
  depth: number
  onOpen(node: AgentThreadNode): void
  onPromote(node: AgentThreadNode): void
}) {
  const t = useTranslations("agentThreadBrowser")
  return (
    <div>
      <div
        className="flex items-center gap-1 rounded-md hover:bg-accent"
        style={{ paddingLeft: depth * 16 }}
      >
        <button
          type="button"
          className="min-w-0 flex-1 px-2 py-1.5 text-left text-sm"
          onClick={() => onOpen(node)}
        >
          <span className="block truncate">{node.session.title}</span>
          <span className="text-[10px] text-muted-foreground">
            {node.running
              ? t("running")
              : node.session.kind === "subagent"
                ? t("completed")
                : t("primary")}
          </span>
        </button>
        {node.session.kind === "subagent" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("promote", { name: node.session.title })}
                  disabled={node.running}
                  onClick={() => onPromote(node)}
                >
                  <CopyPlusIcon className="size-3.5" />
                </Button>
              </span>
            </TooltipTrigger>
            {node.running && <TooltipContent>{t("promotionBlocked")}</TooltipContent>}
          </Tooltip>
        )}
      </div>
      {node.children.map((child) => (
        <AgentThreadRow
          key={child.session.id}
          node={child}
          depth={depth + 1}
          onOpen={onOpen}
          onPromote={onPromote}
        />
      ))}
    </div>
  )
}

/** Count of running subagent nodes across the whole forest (any depth). */
function countRunning(nodes: readonly AgentThreadNode[]): number {
  let total = 0
  for (const node of nodes) {
    if (node.running && node.session.kind === "subagent") total += 1
    total += countRunning(node.children)
  }
  return total
}

export function AgentThreadBrowser() {
  const t = useTranslations("agentThreadBrowser")
  const [open, setOpen] = useState(false)
  const sessions = useLiveQuery(() => listAgentThreadSessions(), [], [])
  const chatSessions = useChatStore((state) => state.sessions)
  const forest = useMemo(() => {
    const running = new Set(
      Object.entries(chatSessions)
        .filter(([, slice]) => slice.status === "streaming" || slice.status === "awaiting_approval")
        .map(([id]) => id)
    )
    return buildAgentThreadForest(sessions ?? [], running)
  }, [sessions, chatSessions])
  const runningCount = useMemo(() => countRunning(forest), [forest])

  const openNode = (node: AgentThreadNode) => {
    const projectStore = useProjectStore.getState()
    if (node.session.projectId && node.session.projectId !== projectStore.activeProjectId) {
      projectStore.setActiveProject(node.session.projectId)
    }
    useUIStore.getState().setSelectedGuild({ kind: "dm" })
    useChatStore.getState().setActiveSession(node.session.id)
    setOpen(false)
  }
  const promote = async (node: AgentThreadNode) => {
    const promoted = await promoteSubagentSession(node.session.id, node.running)
    if (promoted.projectId) {
      useProjectStore.getState().addSessionToProject(promoted.projectId, promoted.id)
    }
    openNode({ session: promoted, children: [], running: false })
  }

  // Nothing to browse → no segment. Same rule as `StatusBarTerminal`.
  if (forest.length === 0) return null

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          data-testid="status-agent-threads"
          data-running={runningCount > 0 ? "true" : "false"}
          aria-label={t("open")}
          title={t("open")}
          className={cn(
            "flex h-6 shrink-0 items-center gap-1 px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
            open && "bg-muted/70"
          )}
        >
          <BotIcon className="size-3" aria-hidden />
          <span>{t("trigger")}</span>
          {runningCount > 0 ? (
            <Badge variant="secondary" className="h-4 min-w-4 px-1 text-[10px]">
              {runningCount}
            </Badge>
          ) : null}
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh]">
          {forest.map((node) => (
            <AgentThreadRow
              key={node.session.id}
              node={node}
              depth={0}
              onOpen={openNode}
              onPromote={(item) => void promote(item)}
            />
          ))}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
