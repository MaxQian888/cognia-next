"use client"

/**
 * AgentModeSelector - Select agent sub-modes in chat interface
 * Enhanced with custom mode management, edit/delete capabilities
 */

import { useState, useMemo } from "react"
import { useShallow } from "zustand/react/shallow"
import { useTranslations } from "next-intl"
import {
  Bot,
  Layout,
  Code2,
  BarChart3,
  PenTool,
  Search,
  Settings,
  ChevronDown,
  Plus,
  Check,
  Edit,
  Trash2,
  Copy,
  Users,
  type LucideIcon,
} from "lucide-react"
import { LucideIcons } from "@/lib/agent/resolve-icon"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuGroup,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { BUILT_IN_AGENT_MODES, type AgentModeConfig } from "@/types/agent/agent-mode"
import { useCustomModeStore, type CustomModeConfig } from "@/stores/agent/custom-mode-store"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { TEAM_STATUS_CONFIG } from "@/types/agent/agent-team"
import { CustomModeEditor } from "./custom-mode-editor"

// =============================================================================
// Icon Mapping
// =============================================================================

const builtInIconMap: Record<string, LucideIcon> = {
  Bot,
  Layout,
  Code2,
  BarChart3,
  PenTool,
  Search,
  Settings,
}

function ModeIcon({ name, className }: { name: string; className?: string }) {
  // First check built-in icons, then try to get from Icons namespace
  const Icon = builtInIconMap[name] || LucideIcons[name] || Bot
  return <Icon className={className} />
}

// =============================================================================
// Types
// =============================================================================

interface AgentModeSelectorProps {
  selectedModeId: string
  onModeChange: (mode: AgentModeConfig | CustomModeConfig) => void
  onCustomModeCreate?: (mode: Partial<AgentModeConfig>) => void
  onCreateTeam?: () => void
  onSelectTeam?: (teamId: string) => void
  disabled?: boolean
  className?: string
}

// =============================================================================
// Main Component
// =============================================================================

export function AgentModeSelector({
  selectedModeId,
  onModeChange,
  onCustomModeCreate,
  onCreateTeam,
  onSelectTeam,
  disabled,
  className,
}: AgentModeSelectorProps) {
  const t = useTranslations("agentMode")
  const tCommon = useTranslations("common")
  const tTeamStatus = useTranslations("agentTeam.status")

  // Custom mode store
  const { customModes, deleteMode, duplicateMode, recordModeUsage } = useCustomModeStore()

  // Agent team store
  const teamsList = useAgentTeamStore(useShallow((s) => Object.values(s.teams)))
  const activeTeams = useMemo(
    () =>
      teamsList.filter(
        (t) => t.status === "executing" || t.status === "planning" || t.status === "paused"
      ),
    [teamsList]
  )

  // Local state
  const [showEditor, setShowEditor] = useState(false)
  const [editingMode, setEditingMode] = useState<CustomModeConfig | undefined>()
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  // Get all custom modes as array
  const customModesList = useMemo(() => Object.values(customModes), [customModes])

  // Find selected mode from both built-in and custom
  const selectedMode = useMemo(() => {
    const builtIn = BUILT_IN_AGENT_MODES.find((m) => m.id === selectedModeId)
    if (builtIn) return builtIn
    return customModes[selectedModeId] || BUILT_IN_AGENT_MODES[0]
  }, [selectedModeId, customModes])

  // Handle mode selection
  const handleModeSelect = (mode: AgentModeConfig | CustomModeConfig) => {
    onModeChange(mode)
    // Track usage for custom modes
    if ("isBuiltIn" in mode && mode.isBuiltIn === false) {
      recordModeUsage(mode.id)
    }
  }

  // Handle edit
  const handleEdit = (mode: CustomModeConfig, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingMode(mode)
    setShowEditor(true)
  }

  // Handle duplicate
  const handleDuplicate = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    duplicateMode(id)
  }

  // Handle delete confirmation
  const handleDeleteConfirm = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setDeleteConfirmId(id)
  }

  // Handle actual delete
  const handleDelete = () => {
    if (deleteConfirmId) {
      deleteMode(deleteConfirmId)
      setDeleteConfirmId(null)
    }
  }

  // Handle create new
  const handleCreateNew = () => {
    setEditingMode(undefined)
    setShowEditor(true)
  }

  // Handle save from editor
  const handleEditorSave = (mode: CustomModeConfig) => {
    // If we have the legacy callback, use it
    if (onCustomModeCreate && !editingMode) {
      onCustomModeCreate(mode)
    }
    setShowEditor(false)
    setEditingMode(undefined)
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            className={cn("gap-2", className)}
          >
            <ModeIcon name={selectedMode.icon} className="h-4 w-4" />
            <span className="hidden sm:inline">
              {selectedMode.type === "custom"
                ? selectedMode.name
                : t(`modes.${selectedMode.id}.name`)}
            </span>
            <ChevronDown className="h-3 w-3 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="w-80">
          <div className="flex flex-col">
            {/* Scrollable content for all modes */}
            <ScrollArea className="max-h-[400px]">
              {/* Built-in Modes Section */}
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  {t("builtInModes")}
                </DropdownMenuLabel>
                {BUILT_IN_AGENT_MODES.map((mode) => {
                  const isSelected = mode.id === selectedModeId
                  return (
                    <DropdownMenuItem
                      key={mode.id}
                      onClick={() => handleModeSelect(mode)}
                      className="flex items-start gap-3 p-3"
                    >
                      <div
                        className={cn(
                          "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                          isSelected ? "bg-primary text-primary-foreground" : "bg-muted"
                        )}
                      >
                        <ModeIcon name={mode.icon} className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{t(`modes.${mode.id}.name`)}</span>
                          {isSelected && <Check className="h-3 w-3 text-primary" />}
                        </div>
                        <p className="text-xs text-muted-foreground line-clamp-2">
                          {t(`modes.${mode.id}.description`)}
                        </p>
                        {mode.previewEnabled && (
                          <Badge variant="secondary" className="mt-1 text-[10px]">
                            {t("livePreview")}
                          </Badge>
                        )}
                      </div>
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuGroup>

              {/* Custom Modes Section */}
              {customModesList.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      {t("customModes")}
                    </DropdownMenuLabel>
                    {customModesList.map((mode) => {
                      const isSelected = mode.id === selectedModeId
                      return (
                        <DropdownMenuItem
                          key={mode.id}
                          onClick={() => handleModeSelect(mode)}
                          className="flex items-start gap-3 p-3 group"
                        >
                          <div
                            className={cn(
                              "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                              isSelected ? "bg-primary text-primary-foreground" : "bg-muted"
                            )}
                          >
                            <ModeIcon name={mode.icon} className="h-4 w-4" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm">{mode.name}</span>
                              {isSelected && <Check className="h-3 w-3 text-primary" />}
                            </div>
                            <p className="text-xs text-muted-foreground line-clamp-1">
                              {mode.description}
                            </p>
                            {mode.category && (
                              <Badge variant="outline" className="mt-1 text-[10px]">
                                {mode.category}
                              </Badge>
                            )}
                          </div>
                          {/* Action buttons */}
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6"
                                  onClick={(e) => handleEdit(mode, e)}
                                >
                                  <Edit className="h-3 w-3" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="top">{t("editMode")}</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6"
                                  onClick={(e) => handleDuplicate(mode.id, e)}
                                >
                                  <Copy className="h-3 w-3" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="top">{t("duplicateMode")}</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 text-destructive hover:text-destructive"
                                  onClick={(e) => handleDeleteConfirm(mode.id, e)}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="top">{t("deleteMode")}</TooltipContent>
                            </Tooltip>
                          </div>
                        </DropdownMenuItem>
                      )
                    })}
                  </DropdownMenuGroup>
                </>
              )}
              {/* Agent Teams Section */}
              {(activeTeams.length > 0 || onCreateTeam) && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="text-xs text-muted-foreground flex items-center gap-1.5">
                      <Users className="h-3 w-3" />
                      {t("agentTeams") || "Agent Teams"}
                      {activeTeams.length > 0 && (
                        <Badge variant="default" className="text-[9px] h-4 px-1 animate-pulse">
                          {activeTeams.length}
                        </Badge>
                      )}
                    </DropdownMenuLabel>
                    {activeTeams.map((team) => {
                      const statusCfg = TEAM_STATUS_CONFIG[team.status]
                      return (
                        <DropdownMenuItem
                          key={team.id}
                          onClick={() => onSelectTeam?.(team.id)}
                          className="flex items-start gap-3 p-3"
                        >
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                            <Users className="h-4 w-4" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm">{team.name}</span>
                              <Badge
                                variant="outline"
                                className={cn("text-[9px]", statusCfg.color)}
                              >
                                {tTeamStatus(statusCfg.labelKey)}
                              </Badge>
                            </div>
                            <p className="text-xs text-muted-foreground line-clamp-1">
                              {team.task}
                            </p>
                            <span className="text-[10px] text-muted-foreground">
                              {t("teammatesCount", { count: team.teammateIds.length })}
                            </span>
                          </div>
                        </DropdownMenuItem>
                      )
                    })}
                    {onCreateTeam && (
                      <DropdownMenuItem onClick={onCreateTeam} className="gap-2 text-primary">
                        <Plus className="h-4 w-4" />
                        {t("createTeam") || "Create Team"}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuGroup>
                </>
              )}
            </ScrollArea>

            {/* Create New Mode - outside scroll area */}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleCreateNew} className="gap-2">
              <Plus className="h-4 w-4" />
              {t("createCustomMode")}
            </DropdownMenuItem>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Custom Mode Editor Dialog */}
      <CustomModeEditor
        open={showEditor}
        onOpenChange={setShowEditor}
        mode={editingMode}
        onSave={handleEditorSave}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={!!deleteConfirmId}
        onOpenChange={(open) => !open && setDeleteConfirmId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteMode")}</AlertDialogTitle>
            <AlertDialogDescription>{t("deleteModeConfirm")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {tCommon("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
