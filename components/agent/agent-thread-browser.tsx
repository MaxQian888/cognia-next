"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { BotIcon, CopyPlusIcon } from "lucide-react"
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
import { listSessions } from "@/lib/db/sessions"
import {
  buildAgentThreadForest,
  promoteSubagentSession,
  type AgentThreadNode,
} from "@/lib/agent/thread-browser"
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

export function AgentThreadBrowser() {
  const t = useTranslations("agentThreadBrowser")
  const [open, setOpen] = useState(false)
  const sessions = useLiveQuery(() => listSessions(), [], [])
  const chatSessions = useChatStore((state) => state.sessions)
  const forest = useMemo(() => {
    const running = new Set(
      Object.entries(chatSessions)
        .filter(([, slice]) => slice.status === "streaming" || slice.status === "awaiting_approval")
        .map(([id]) => id)
    )
    return buildAgentThreadForest(sessions ?? [], running)
  }, [sessions, chatSessions])

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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="icon-sm"
          variant="secondary"
          className="fixed right-14 bottom-10 z-40 rounded-full shadow-md"
          aria-label={t("open")}
        >
          <BotIcon className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh]">
          {forest.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            forest.map((node) => (
              <AgentThreadRow
                key={node.session.id}
                node={node}
                depth={0}
                onOpen={openNode}
                onPromote={(item) => void promote(item)}
              />
            ))
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
