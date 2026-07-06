"use client"

/**
 * Agent Teams — management hub.
 *
 * Lists user teams with rich cards, actions, and search, plus built-in
 * templates behind a tab. Creating a team (from scratch or template)
 * opens a Dialog and navigates to the workspace on success.
 */

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useLocale, useTranslations } from "next-intl"
import {
  CopyIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
  Trash2Icon,
  UsersIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
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
import { Switch } from "@/components/ui/switch"
import { StatusBadge } from "@/components/status-badge"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { toast } from "sonner"

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { useUIStore } from "@/stores/ui/ui-store"
import { useTeamLiveStatus } from "@/hooks/agent-runs/use-team-live-status"
import { type AgentTeamTemplate } from "@/types/agent/agent-team"
import type { AgentTeam } from "@/types/agent/agent-team"
import { createSampleTeam } from "@/lib/ai/agent/sample-team"
import { AutoComposeDialog } from "@/components/agent/workspace/auto-compose-dialog"
import { createLogger } from "@/lib/logging"
import {
  getTemplateWarnings,
  listAgentTeamTemplateEntries,
  type PluginAgentTeamTemplateWarning,
} from "@/lib/plugin/registries/agent-team-template-registry"
import { projectPluginTemplate } from "@/lib/agent-team/project-plugin-template"

const log = createLogger("agentTeams.list")

/** Merge built-in / user templates with plugin-overlay templates + warnings. */
function useMergedTemplates(localTemplates: AgentTeamTemplate[]): {
  merged: AgentTeamTemplate[]
  warningsById: Map<string, readonly PluginAgentTeamTemplateWarning[]>
} {
  return useMemo(() => {
    const warningsById = new Map<string, readonly PluginAgentTeamTemplateWarning[]>()
    const pluginProjected = listAgentTeamTemplateEntries().map((entry) => {
      const projected = projectPluginTemplate(entry)
      const warnings = getTemplateWarnings(entry.id)
      if (warnings.length > 0) warningsById.set(projected.id, warnings)
      return projected
    })
    return { merged: [...localTemplates, ...pluginProjected], warningsById }
  }, [localTemplates])
}

const TEMPLATE_CATEGORIES = [
  "all",
  "review",
  "research",
  "development",
  "debugging",
  "analysis",
  "general",
  "documentation",
  "security",
] as const

/* ------------------------------------------------------------------ */
/*  Time-ago helper                                                     */
/* ------------------------------------------------------------------ */

function timeAgo(date: Date, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
  const diff = new Date(date).getTime() - Date.now()
  const secs = Math.round(diff / 1000)
  const absSecs = Math.abs(secs)
  if (absSecs < 60) return rtf.format(secs, "second")
  const mins = Math.round(diff / 60_000)
  if (Math.abs(mins) < 60) return rtf.format(mins, "minute")
  const hours = Math.round(diff / 3_600_000)
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour")
  const days = Math.round(diff / 86_400_000)
  if (Math.abs(days) < 30) return rtf.format(days, "day")
  return rtf.format(Math.round(days / 30), "month")
}

/* ------------------------------------------------------------------ */
/*  Page component                                                     */
/* ------------------------------------------------------------------ */

export default function AgentTeamsListPage() {
  const router = useRouter()
  const t = useTranslations("agentTeamsWorkspace")
  const tCat = useTranslations("agentTeamsWorkspace.templates.categories")

  const teams = useAgentTeamStore((s) => s.teams)
  const teammates = useAgentTeamStore((s) => s.teammates)
  const templates = useAgentTeamStore((s) => s.templates)
  const createTeam = useAgentTeamStore((s) => s.createTeam)
  const addTeammate = useAgentTeamStore((s) => s.addTeammate)
  const deleteTeam = useAgentTeamStore((s) => s.deleteTeam)
  const updateTeam = useAgentTeamStore((s) => s.updateTeam)

  const [search, setSearch] = useState("")
  const [activeTab, setActiveTab] = useState("my-teams")
  const [categoryFilter, setCategoryFilter] = useState("all")
  const [createOpen, setCreateOpen] = useState(false)
  const [autoComposeOpen, setAutoComposeOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const [deletingTeam, setDeletingTeam] = useState<AgentTeam | null>(null)

  // Honor the File → New Agent Team menu item: when the ui-store flags an
  // agentTeam-create request, switch to the templates tab and pop the
  // create dialog, then clear the signal.
  const pendingCreate = useUIStore((s) => s.pendingCreateRequest)
  const clearPendingCreate = useUIStore((s) => s.clearPendingCreate)
  useEffect(() => {
    if (pendingCreate?.kind === "agentTeam") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional bridge from Zustand pendingCreate signal to local Dialog state.
      setCreateOpen(true)
      setActiveTab("templates")
      clearPendingCreate()
    }
  }, [pendingCreate, clearPendingCreate])

  /* ---- derived data ---- */
  const teamList = useMemo(() => {
    const all = Object.values(teams)
    all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    if (!search.trim()) return all
    const q = search.toLowerCase()
    return all.filter(
      (t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
    )
  }, [teams, search])

  const stats = useMemo(() => {
    const all = Object.values(teams)
    const active = all.filter((t) => t.status === "executing" || t.status === "planning").length
    const totalTeammates = Object.values(teammates).length
    return { total: all.length, active, totalTeammates }
  }, [teams, teammates])

  const localTemplates = useMemo(() => Object.values(templates), [templates])
  const { merged: allTemplates, warningsById: templateWarnings } =
    useMergedTemplates(localTemplates)

  const filteredTemplates = useMemo(() => {
    const all = [...allTemplates].sort((a, b) => {
      const aBuilt = a.isBuiltIn ?? false
      const bBuilt = b.isBuiltIn ?? false
      if (aBuilt !== bBuilt) return aBuilt ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    if (categoryFilter === "all") return all
    return all.filter((tpl) => tpl.category === categoryFilter)
  }, [allTemplates, categoryFilter])

  /* ---- actions ---- */
  const handlePickTemplate = (tpl: AgentTeamTemplate) => {
    const team = createTeam({
      name: tpl.name,
      description: tpl.description,
      task: tpl.description,
      config: tpl.config,
    })
    for (const tm of tpl.teammates) {
      addTeammate({
        teamId: team.id,
        name: tm.name,
        description: tm.description,
        role: "teammate",
        config: {
          ...tm.config,
          systemPrompt: tm.systemPrompt ?? tm.config?.systemPrompt,
          capabilities: tm.capabilities ?? tm.config?.capabilities,
          specialization: tm.specialization ?? tm.config?.specialization,
        },
      })
    }
    log.info("template_used", { templateId: tpl.id, teamId: team.id })
    router.push(`/agent-teams/workspace?teamId=${team.id}`)
  }

  const handleDelete = (team: AgentTeam) => {
    deleteTeam(team.id)
    toast.success(t("teamDeleted", { name: team.name }))
    setDeletingTeam(null)
  }

  const handleDuplicate = (team: AgentTeam) => {
    const copy = createTeam({
      name: t("duplicatedName", { name: team.name }),
      description: team.description,
      task: team.task,
      config: { ...team.config },
    })
    for (const tid of team.teammateIds) {
      const src = teammates[tid]
      if (src) {
        addTeammate({
          teamId: copy.id,
          name: src.name,
          description: src.description,
          role: src.role,
          config: { ...src.config },
        })
      }
    }
    toast.success(t("teamDuplicated", { name: copy.name }))
  }

  const startRename = (team: AgentTeam) => {
    setEditingId(team.id)
    setEditName(team.name)
  }

  const commitRename = (id: string) => {
    if (editName.trim()) {
      updateTeam(id, { name: editName.trim() })
    }
    setEditingId(null)
  }

  /* ---- render ---- */
  return (
    <div
      className="flex h-full min-h-0 w-full flex-col space-y-6 overflow-y-auto p-4 sm:p-6"
      data-testid="agent-teams-list-page"
      data-bg-target="chat"
    >
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <Label className="text-lg font-semibold">{t("listTitle")}</Label>
          <p className="text-sm text-muted-foreground">{t("listDescription")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const { teamId } = createSampleTeam()
              toast.success(t("sampleTeamCreated"))
              log.info("sample_team_created", { teamId })
              router.push(`/agent-teams/workspace?teamId=${teamId}`)
            }}
            data-testid="agent-teams-try-sample"
          >
            <SparklesIcon className="mr-2 size-4" />
            {t("trySampleTeam")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAutoComposeOpen(true)}
            data-testid="agent-teams-auto-compose"
          >
            <SparklesIcon className="mr-2 size-4" />
            {t("autoCompose.openButton")}
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <PlusIcon className="mr-2 size-4" />
            {t("createTeam")}
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="space-y-1 p-3 text-center sm:p-4">
          <p className="text-2xl font-semibold tabular-nums">{stats.total}</p>
          <p className="text-xs text-muted-foreground">{t("stats.totalTeams")}</p>
        </Card>
        <Card className="space-y-1 p-3 text-center sm:p-4">
          <p className="text-2xl font-semibold tabular-nums text-primary">{stats.active}</p>
          <p className="text-xs text-muted-foreground">{t("stats.activeTeams")}</p>
        </Card>
        <Card className="space-y-1 p-3 text-center sm:p-4">
          <p className="text-2xl font-semibold tabular-nums">{stats.totalTeammates}</p>
          <p className="text-xs text-muted-foreground">{t("stats.totalTeammates")}</p>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="my-teams">{t("myTeams")}</TabsTrigger>
          <TabsTrigger value="templates">{t("templatesTab")}</TabsTrigger>
        </TabsList>

        {/* ---- My Teams ---- */}
        <TabsContent value="my-teams" className="space-y-4 pt-4">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("searchTeams")}
                className="h-8 pl-8 text-xs"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  aria-label={t("clearSearch")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <XIcon className="size-3" />
                </button>
              )}
            </div>
          </div>

          {teamList.length === 0 ? (
            search ? (
              <Empty>
                <EmptyMedia variant="icon">
                  <SearchIcon />
                </EmptyMedia>
                <EmptyHeader>
                  <EmptyTitle>{t("noResults")}</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <Empty>
                <EmptyMedia variant="icon">
                  <UsersIcon />
                </EmptyMedia>
                <EmptyHeader>
                  <EmptyTitle>{t("listEmpty")}</EmptyTitle>
                  <EmptyDescription>{t("listDescription")}</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button size="sm" onClick={() => setCreateOpen(true)}>
                    <PlusIcon className="mr-2 size-4" />
                    {t("createTeam")}
                  </Button>
                </EmptyContent>
              </Empty>
            )
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {teamList.map((team) => (
                <TeamCard
                  key={team.id}
                  team={team}
                  teammates={teammates}
                  editing={editingId === team.id}
                  editName={editName}
                  onEditNameChange={setEditName}
                  onCommitRename={() => commitRename(team.id)}
                  onCancelRename={() => setEditingId(null)}
                  onOpen={() => router.push(`/agent-teams/workspace?teamId=${team.id}`)}
                  onRename={() => startRename(team)}
                  onDuplicate={() => handleDuplicate(team)}
                  onDelete={() => setDeletingTeam(team)}
                />
              ))}
            </div>
          )}
        </TabsContent>

        {/* ---- Templates ---- */}
        <TabsContent value="templates" className="space-y-4 pt-4">
          <div className="flex flex-wrap gap-1.5">
            {TEMPLATE_CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategoryFilter(cat)}
                className={
                  "rounded-full border px-2.5 py-0.5 text-xs transition-colors " +
                  (categoryFilter === cat
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:bg-muted")
                }
              >
                {cat === "all" ? t("allCategories") : tCat(cat)}
              </button>
            ))}
          </div>

          {filteredTemplates.length === 0 ? (
            <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
              {t("noResults")}
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filteredTemplates.map((tpl) => (
                <Card
                  key={tpl.id}
                  className="space-y-2 p-4"
                  data-testid={`template-card-${tpl.id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium">{tpl.name}</p>
                    {tpl.isBuiltIn && (
                      <Badge variant="secondary" className="text-[10px] shrink-0">
                        {t("builtInBadge")}
                      </Badge>
                    )}
                  </div>
                  <p className="line-clamp-3 text-xs text-muted-foreground">{tpl.description}</p>
                  {(templateWarnings.get(tpl.id) ?? []).length > 0 ? (
                    <Badge
                      variant="outline"
                      className="border-amber-500/50 text-[10px] text-amber-600"
                      title={(templateWarnings.get(tpl.id) ?? [])
                        .map((w) => `${w.code}: ${w.missingId}`)
                        .join("\n")}
                      data-testid={`template-warnings-${tpl.id}`}
                    >
                      {t("templates.missingDependencies", {
                        count: (templateWarnings.get(tpl.id) ?? []).length,
                      })}
                    </Badge>
                  ) : null}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] text-muted-foreground">
                      {tCat(tpl.category)} · {t("teammatesCount", { count: tpl.teammates.length })}
                    </span>
                    <Button size="sm" variant="outline" onClick={() => handlePickTemplate(tpl)}>
                      <PlayIcon className="mr-1 size-3" />
                      {t("createTeam")}
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* ---- Create Dialog ---- */}
      <CreateTeamDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        templates={allTemplates}
        onCreated={(teamId) => {
          setCreateOpen(false)
          router.push(`/agent-teams/workspace?teamId=${teamId}`)
        }}
      />

      {/* ---- Auto-compose Dialog ---- */}
      <AutoComposeDialog
        open={autoComposeOpen}
        onOpenChange={setAutoComposeOpen}
        onComposed={(teamId) => {
          setAutoComposeOpen(false)
          router.push(`/agent-teams/workspace?teamId=${teamId}`)
        }}
      />

      {/* ---- Delete confirm ---- */}
      <AlertDialog
        open={!!deletingTeam}
        onOpenChange={(o) => {
          if (!o) setDeletingTeam(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTeam")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteConfirm", { name: deletingTeam?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deletingTeam && handleDelete(deletingTeam)}
            >
              {t("deleteTeam")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Team Card                                                          */
/* ------------------------------------------------------------------ */

interface TeamCardProps {
  team: AgentTeam
  teammates: Record<string, { name: string }>
  editing: boolean
  editName: string
  onEditNameChange: (v: string) => void
  onCommitRename: () => void
  onCancelRename: () => void
  onOpen: () => void
  onRename: () => void
  onDuplicate: () => void
  onDelete: () => void
}

function TeamCard({
  team,
  teammates,
  editing,
  editName,
  onEditNameChange,
  onCommitRename,
  onCancelRename,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
}: TeamCardProps) {
  const t = useTranslations("agentTeamsWorkspace")
  const locale = useLocale()
  // Authoritative run status from the workflowRuns subscription — the store's
  // team.status is only an optimistic in-flight bridge (see agent-team.ts).
  const liveStatus = useTeamLiveStatus(team)
  const memberNames = team.teammateIds.map((id) => teammates[id]?.name ?? "?").slice(0, 3)
  const overflow = Math.max(0, team.teammateIds.length - 3)

  return (
    <Card
      className="group cursor-pointer space-y-2 p-4 transition hover:border-primary"
      onClick={onOpen}
      data-testid={`team-card-${team.id}`}
    >
      <div className="flex items-start gap-3">
        {/* Avatar */}
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-medium">
          {team.name.charAt(0).toUpperCase()}
        </span>

        <div className="min-w-0 flex-1">
          {/* Name row */}
          <div className="flex items-center gap-2">
            {editing ? (
              <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <Input
                  value={editName}
                  onChange={(e) => onEditNameChange(e.target.value)}
                  className="h-7 w-32 text-xs"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onCommitRename()
                    if (e.key === "Escape") onCancelRename()
                  }}
                  autoFocus
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  onClick={onCommitRename}
                  aria-label={t("confirmRename")}
                >
                  ✓
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  onClick={onCancelRename}
                  aria-label={t("cancelRename")}
                >
                  ✕
                </Button>
              </span>
            ) : (
              <p className="text-sm font-medium truncate">{team.name}</p>
            )}
            <StatusBadge
              value={liveStatus}
              labelNamespace="agentTeam.status"
              className="text-[10px] shrink-0"
            />
          </div>

          {/* Description */}
          {team.description && (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{team.description}</p>
          )}

          {/* Meta */}
          <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
            {memberNames.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <span className="flex -space-x-1.5">
                  {memberNames.map((n, i) => (
                    <span
                      key={i}
                      className="flex size-4 items-center justify-center rounded-full border border-background bg-muted text-[8px]"
                    >
                      {n.charAt(0)}
                    </span>
                  ))}
                </span>
                {overflow > 0 && <span>+{overflow}</span>}
              </span>
            )}
            <span>{t("membersCount", { count: team.teammateIds.length })}</span>
            {team.startedAt && <span>{timeAgo(team.startedAt, locale)}</span>}
          </div>
        </div>

        {/* Actions menu */}
        <div
          className="shrink-0 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100"
          onClick={(e) => e.stopPropagation()}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7">
                <MoreHorizontalIcon className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onOpen}>
                <PlayIcon className="mr-2 size-3.5" />
                {liveStatus === "executing" || liveStatus === "planning"
                  ? t("viewWorkspace")
                  : t("openWorkspace")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onRename}>
                <PencilIcon className="mr-2 size-3.5" />
                {t("rename")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onDuplicate}>
                <CopyIcon className="mr-2 size-3.5" />
                {t("duplicate")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onClick={onDelete}>
                <Trash2Icon className="mr-2 size-3.5" />
                {t("delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/*  Create Team Dialog                                                 */
/* ------------------------------------------------------------------ */

interface CreateTeamDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  templates: AgentTeamTemplate[]
  onCreated: (teamId: string) => void
}

function CreateTeamDialog({ open, onOpenChange, templates, onCreated }: CreateTeamDialogProps) {
  const t = useTranslations("agentTeamsWorkspace")
  const createTeam = useAgentTeamStore((s) => s.createTeam)
  const addTeammate = useAgentTeamStore((s) => s.addTeammate)

  const [mode, setMode] = useState<"template" | "scratch">("template")
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [requirePlanApproval, setRequirePlanApproval] = useState(false)
  const [saving, setSaving] = useState(false)

  const handleCreateFromScratch = () => {
    if (!name.trim()) {
      toast.error(t("teamNameRequired"))
      return
    }
    setSaving(true)
    try {
      const team = createTeam({
        name: name.trim(),
        description: description.trim() || t("defaultTeamDescription"),
        task: description.trim() || name.trim(),
        config: { requirePlanApproval },
      })
      addTeammate({
        teamId: team.id,
        name: "Team Lead",
        description: "Lead agent",
        role: "lead",
      })
      toast.success(t("teamCreated", { name: team.name }))
      onCreated(team.id)
      reset()
    } finally {
      setSaving(false)
    }
  }

  const handlePickTemplate = (tpl: AgentTeamTemplate) => {
    setSaving(true)
    try {
      const team = createTeam({
        name: tpl.name,
        description: tpl.description,
        task: tpl.description,
        config: tpl.config,
      })
      for (const tm of tpl.teammates) {
        addTeammate({
          teamId: team.id,
          name: tm.name,
          description: tm.description,
          role: "teammate",
          config: {
            ...tm.config,
            systemPrompt: tm.systemPrompt ?? tm.config?.systemPrompt,
            capabilities: tm.capabilities ?? tm.config?.capabilities,
            specialization: tm.specialization ?? tm.config?.specialization,
          },
        })
      }
      toast.success(t("teamCreated", { name: team.name }))
      onCreated(team.id)
      reset()
    } finally {
      setSaving(false)
    }
  }

  const reset = () => {
    setName("")
    setDescription("")
    setRequirePlanApproval(false)
    setMode("template")
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("createTeamTitle")}</DialogTitle>
          <DialogDescription>{t("createTeamDescription")}</DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMode("template")}
            className={
              "flex-1 rounded-md border px-3 py-2 text-xs font-medium transition-colors " +
              (mode === "template"
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:bg-muted")
            }
          >
            {t("createFromTemplate")}
          </button>
          <button
            type="button"
            onClick={() => setMode("scratch")}
            className={
              "flex-1 rounded-md border px-3 py-2 text-xs font-medium transition-colors " +
              (mode === "scratch"
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:bg-muted")
            }
          >
            {t("createFromScratch")}
          </button>
        </div>

        {mode === "template" ? (
          <div className="grid max-h-64 gap-2 overflow-y-auto">
            {templates.length === 0 ? (
              <p className="text-center text-xs text-muted-foreground py-4">
                {t("noTemplatesAvailable")}
              </p>
            ) : (
              templates.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  disabled={saving}
                  onClick={() => handlePickTemplate(tpl)}
                  className="flex items-start gap-3 rounded-md border p-3 text-left transition hover:border-primary disabled:opacity-50"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium">
                    {tpl.name.charAt(0)}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{tpl.name}</p>
                    <p className="line-clamp-2 text-xs text-muted-foreground">{tpl.description}</p>
                  </div>
                </button>
              ))
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">{t("teamNameLabel")}</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("teamNamePlaceholder")}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t("descriptionTaskLabel")}</Label>
              <Textarea
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("descriptionTaskPlaceholder")}
                className="text-xs"
              />
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-xs">{t("requirePlanApproval")}</Label>
              <Switch checked={requirePlanApproval} onCheckedChange={setRequirePlanApproval} />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          {mode === "scratch" && (
            <Button size="sm" onClick={handleCreateFromScratch} disabled={saving}>
              {saving ? t("creating") : t("createTeam")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
