"use client"

/**
 * One agent (ADR-0220), shaped like a Squad's view: a masthead with who it is
 * and the verbs that act on it (chat, assign work, edit, the lifecycle menu),
 * then one page — the profile; the form in its place while editing; or the
 * durable task board at full width, since an eight-column kanban squeezed
 * into the profile's main column is unreadable. No tabs: what the agent does
 * and what it is fit side by side on one screen.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ArrowLeftIcon, CopyIcon, ListPlusIcon, MessageSquareIcon, PencilIcon } from "lucide-react"
import type { Character } from "@cognia/agent-config-types"
import { AgentTaskBoard } from "@/components/agent/agent-task-board"
import { Button } from "@/components/ui/button"
import { usePluginMetadata } from "@/hooks/plugins/use-plugin-metadata"
import { useAgentActivity } from "@/hooks/agents/use-agent-activity"
import { useAgentActions } from "@/hooks/agents/use-agent-actions"
import type { AgentCatalogs } from "@/hooks/agents/use-agent-catalogs"
import { describeAgentSource } from "@/lib/agents/agent-source"
import type { AgentDetailMode } from "@/lib/agents/routes"
import { cn } from "@/lib/utils"
import { AgentActionsMenu } from "../agent-actions-menu"
import { AgentAvatar, AgentSourceBadges, AgentStatusLabel } from "../agent-visuals"
import { AgentAssignWorkDialog } from "./agent-assign-work-dialog"
import { AgentEditView } from "./agent-edit-view"
import { AgentProfile } from "./agent-profile"
import { AgentSectionEmpty } from "./agent-section"

export interface AgentDetailViewProps {
  agent: Character
  /** Every agent, for variant base names. */
  agents: readonly Character[]
  catalogs: AgentCatalogs
  mode: AgentDetailMode
  onModeChange: (mode: AgentDetailMode) => void
  onOpenAgent: (id: string, mode?: "edit") => void
  onDeleted: () => void
  onStartChat: (agent: Character) => void
  starting?: boolean
  /** Pending pack updates among this agent's pack siblings. */
  siblingPendingCount?: number
  /** Phone layout: tighter padding, and no "View in Issues" (the phone's list cannot filter). */
  compact?: boolean
}

export function AgentDetailView({
  agent,
  agents,
  catalogs,
  mode,
  onModeChange,
  onOpenAgent,
  onDeleted,
  onStartChat,
  starting,
  siblingPendingCount,
  compact = false,
}: AgentDetailViewProps) {
  const t = useTranslations("agentsConsole.detail")
  const tChars = useTranslations("settings.characters")
  const activity = useAgentActivity(agent.id)
  const actions = useAgentActions()
  const [assignOpen, setAssignOpen] = useState(false)
  const source = describeAgentSource(agent)
  const pluginMeta = usePluginMetadata(source.sourcePluginId)
  const baseName = agent.variant
    ? agents.find((other) => other.id === agent.variant?.baseId)?.name
    : undefined
  const pluginName = pluginMeta?.name ?? source.sourcePluginId ?? ""
  const sourceLabel = agent.isBuiltIn
    ? tChars("builtIn")
    : source.isOverlay
      ? source.fromLocalFile
        ? tChars("badge.fromLocalFile")
        : tChars("badge.fromPlugin", { name: pluginName })
      : source.isCloned
        ? source.fromLocalFile
          ? tChars("badge.clonedFromLocalFile")
          : tChars("badge.cloned", { name: pluginName })
        : t("sourceUser")
  const duplicateAndEdit = () =>
    void actions.duplicate(agent).then((copy) => copy && onOpenAgent(copy.id, "edit"))
  const editing = mode === "edit"
  const boardOpen = mode === "tasks"
  // Edit and the board are sub-pages of the profile: a way back, and a title
  // that says where you are.
  const subPage = editing || boardOpen

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="agent-detail" data-mode={mode}>
      <header
        className={cn(
          "@container/agent-masthead shrink-0 border-b",
          compact ? "px-4 py-3" : "px-6 py-5"
        )}
      >
        <div className="flex flex-col gap-4 @2xl/agent-masthead:flex-row @2xl/agent-masthead:items-center @2xl/agent-masthead:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            {subPage ? (
              <Button
                variant="ghost"
                size="icon"
                className="-ml-1 size-8 shrink-0"
                onClick={() => onModeChange("overview")}
                aria-label={t("backToProfile")}
                data-testid="agent-edit-back"
              >
                <ArrowLeftIcon className="size-4" aria-hidden />
              </Button>
            ) : null}
            <AgentAvatar agent={agent} size={compact ? 40 : 48} status={activity?.status} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <h2
                  className="min-w-0 truncate text-lg font-semibold leading-tight"
                  data-testid="agent-detail-name"
                >
                  {editing
                    ? t("editing", { name: agent.name })
                    : boardOpen
                      ? t("tasksTitle", { name: agent.name })
                      : agent.name}
                </h2>
                {activity && activity.status !== "idle" ? (
                  <AgentStatusLabel status={activity.status} />
                ) : null}
                <AgentSourceBadges agent={agent} source={source} baseName={baseName} />
              </div>
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                {agent.description?.trim() || t("noDescription")}
              </p>
            </div>
          </div>
          {editing ? null : boardOpen ? (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={() => setAssignOpen(true)}
              data-testid="agent-assign-work"
            >
              <ListPlusIcon className="size-3.5" aria-hidden />
              {t("assignWork")}
            </Button>
          ) : (
            <div className="flex shrink-0 items-center gap-2">
              <Button
                size="sm"
                disabled={starting}
                onClick={() => onStartChat(agent)}
                data-testid="agent-start-chat"
              >
                <MessageSquareIcon className="size-3.5" aria-hidden />
                {t("chat")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setAssignOpen(true)}
                data-testid="agent-assign-work"
              >
                <ListPlusIcon className="size-3.5" aria-hidden />
                {t("assignWork")}
              </Button>
              {source.editable ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onModeChange("edit")}
                  data-testid="agent-edit"
                >
                  <PencilIcon className="size-3.5" aria-hidden />
                  {t("edit")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={duplicateAndEdit}
                  title={agent.isBuiltIn ? tChars("builtInReadOnly") : tChars("overlayReadOnly")}
                  data-testid="agent-duplicate-to-edit"
                >
                  <CopyIcon className="size-3.5" aria-hidden />
                  {t("duplicateToEdit")}
                </Button>
              )}
              <AgentActionsMenu
                agent={agent}
                siblingPendingCount={siblingPendingCount}
                onOpenAgent={onOpenAgent}
                onDeleted={onDeleted}
              />
            </div>
          )}
        </div>
      </header>

      <div
        className={cn(
          "min-h-0 flex-1",
          // The board fills the body and scrolls inside its columns; the
          // profile and the form scroll as a page.
          boardOpen ? "flex flex-col overflow-hidden" : "overflow-y-auto",
          compact ? "p-4" : boardOpen ? "px-6 py-5" : "px-6 py-6"
        )}
      >
        {boardOpen ? (
          <AgentTaskBoard
            agentId={agent.id}
            showCreateForm={false}
            className="flex-1"
            emptyState={<AgentSectionEmpty>{t("tasksEmpty")}</AgentSectionEmpty>}
          />
        ) : editing ? (
          <AgentEditView
            agent={agent}
            editable={source.editable}
            catalogs={catalogs}
            baseName={baseName}
            onDuplicate={duplicateAndEdit}
            onDone={() => onModeChange("overview")}
          />
        ) : (
          <AgentProfile
            agent={agent}
            activity={activity}
            catalogs={catalogs}
            sourceLabel={sourceLabel}
            onEdit={source.editable ? () => onModeChange("edit") : undefined}
            onOpenTasks={() => onModeChange("tasks")}
            compact={compact}
          />
        )}
      </div>

      <AgentAssignWorkDialog agent={agent} open={assignOpen} onOpenChange={setAssignOpen} />
    </div>
  )
}
