"use client"

/**
 * `/workspace`: the current workspace at a glance.
 *
 * "Workspace" here is the repo's existing `Project` entity (`lib/db/projects.ts`,
 * user-facing label "Workspace"), NOT a new container and NOT the tracker's
 * `IssueProject`. This page exists to give that entity a real home: its
 * delivery containers, its issue totals, and the roots it has mounted.
 *
 * Hard constraint: this must not become a SECOND place that edits workspace
 * roots. `components/shell/workspace-manage-dialog.tsx` already owns those
 * mutations, so this surface MOUNTS THAT SAME DIALOG behind its "Manage"
 * button rather than duplicating the controls. One editor component, two
 * entry points (here and the switcher). Two editors over one row is the
 * "double entry point" defect this repo keeps re-learning. Two doors into one
 * editor is fine.

 * The same rule is why the header's switcher is `WorkspacePickerList`, the
 * exact list the rail popover and the mobile drawer render, and why the
 * Environments tab mounts `ProjectEnvironmentManager` whole instead of its two
 * children: that component was reachable only from chat, through session
 * settings, so the repo-config and provisioning offers had no entry from the
 * page about the workspace they configure.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronsUpDownIcon,
  FolderIcon,
  SettingsIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
} from "lucide-react"
import Link from "next/link"

import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { WorkspaceManageDialog } from "@/components/shell/workspace-manage-dialog"
import { ConsoleSection } from "@/components/surface/console-section"
import { StatStrip, type StatStripItem } from "@/components/surface/stat-strip"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ProjectEnvironmentManager } from "@/components/settings/project-environment-manager"
import { SourceControlPanel } from "@/components/source-control/source-control-panel"
import { listWorkspaceEnvironments } from "@/lib/task-workspace/client"
import { useClientLiveQuery } from "@/hooks/data"
import { listIssues } from "@/lib/db/issues"
import { listIssueProjects } from "@/lib/db/issue-projects"
import { listActiveIssueRunIssueIds } from "@/lib/db/issue-runs"
import { listTrustedWorkspaces } from "@/lib/db/trusted-workspaces"
import { ISSUE_STATUSES, statusCategoryOf } from "@/types/issues"
import type { IssueProject, IssueStatus } from "@/types/issues"
import { useProjectStore } from "@/stores/project/project-store"
import { IssueStatusIcon } from "@/components/issues/issue-glyphs"
import { WorkspaceCapabilities } from "./workspace-capabilities"
import { WorkspaceMembers } from "./workspace-members"
import { WorkspaceActivity } from "./workspace-activity"
import { AgentBranchesSection } from "./agent-branches-section"
import { WorkspaceEnvironmentList } from "./workspace-environment-list"
import { useWorkspacePickerDialogs, WorkspacePickerList } from "./workspace-picker-list"

/** Trailing-separator-insensitive, matching `lib/db/trusted-workspaces.ts`. */
function normalizePath(path: string): string {
  let p = path.trim()
  while (p.endsWith("/") || p.endsWith("\\")) p = p.slice(0, -1)
  return p
}

export function WorkspaceOverview() {
  const t = useTranslations("issues")
  // The Capabilities tab has its own namespace: it is about the workspace's
  // relationship to the skill/MCP libraries, not about issues.
  const tCapabilities = useTranslations("workspace.capabilities")
  const tSwitcher = useTranslations("workspace.switcher")
  const workspaceId = useProjectStore((s) => s.activeProjectId)
  const workspaces = useProjectStore((s) => s.projects)
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId)
  const [manageOpen, setManageOpen] = useState(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  // Mounted outside the Popover, because it closes before opening any of them
  // and a Popover unmounts its children on close. The picker says so itself.
  const { actions: pickerActions, element: pickerDialogs } = useWorkspacePickerDialogs()

  const primaryRoot =
    workspace?.roots?.find((root) => root.isPrimary)?.path ?? workspace?.roots?.[0]?.path

  const projects = useClientLiveQuery(
    () => (workspaceId ? listIssueProjects({ projectId: workspaceId }) : Promise.resolve([])),
    [workspaceId],
    [] as IssueProject[]
  )
  const issues = useClientLiveQuery(
    () => (workspaceId ? listIssues({ projectId: workspaceId }) : Promise.resolve([])),
    [workspaceId],
    []
  )
  const runningIssueIds = useClientLiveQuery(
    () =>
      workspaceId ? listActiveIssueRunIssueIds(workspaceId) : Promise.resolve(new Set<string>()),
    [workspaceId],
    new Set<string>()
  )
  const trusted = useClientLiveQuery(() => listTrustedWorkspaces(), [], [])
  const trustedPaths = useMemo(
    () => new Set((trusted ?? []).map((row) => normalizePath(row.path))),
    [trusted]
  )

  /**
   * How many execution environments this workspace owns.
   *
   * Read here rather than lifted out of the Environments tab: Radix unmounts an
   * inactive tab, so a count sourced from the list would stay unknown for
   * exactly the person the number is for, the one who never opened it. This is
   * the same low-risk host read the list makes, once per root change.
   */
  // Keyed by what it counted, rather than reset synchronously when the key
  // changes: clearing it in the effect body is a cascading render, and reading
  // "does this answer describe the workspace I am looking at" off the stored
  // key gets the same staleness guarantee for free.
  const environmentScopeKey = `${primaryRoot ?? ""}|${workspaceId ?? ""}`
  const [environmentCount, setEnvironmentCount] = useState<{ key: string; count: number } | null>(
    null
  )
  useEffect(() => {
    let cancelled = false
    void listWorkspaceEnvironments(primaryRoot).then(
      (rows) => {
        if (cancelled) return
        const count = workspaceId
          ? rows.filter((row) => row.projectId === workspaceId).length
          : rows.length
        setEnvironmentCount({ key: environmentScopeKey, count })
      },
      () => {
        // A host that cannot answer leaves the tile unknown rather than zero.
        if (!cancelled) setEnvironmentCount(null)
      }
    )
    return () => {
      cancelled = true
    }
  }, [primaryRoot, workspaceId, environmentScopeKey])

  const environments = environmentCount?.key === environmentScopeKey ? environmentCount.count : null

  const counts = useMemo(() => {
    const byStatus = Object.fromEntries(ISSUE_STATUSES.map((status) => [status, 0])) as Record<
      IssueStatus,
      number
    >
    let open = 0
    for (const issue of issues ?? []) {
      byStatus[issue.status] += 1
      const category = statusCategoryOf(issue.status)
      if (category === "unstarted" || category === "started") open += 1
    }
    return { byStatus, open }
  }, [issues])

  const stats: StatStripItem[] = [
    { id: "open-issues", label: t("workspace.openIssues"), value: counts.open },
    { id: "projects", label: t("workspace.projectSummary"), value: (projects ?? []).length },
    {
      id: "agents-working",
      label: t("workspace.agentsWorking"),
      value: runningIssueIds?.size ?? 0,
      tone: (runningIssueIds?.size ?? 0) > 0 ? "positive" : "neutral",
    },
    {
      // The fourth tile exists so the Environments tab is discoverable at all.
      // A workspace with worktrees on disk gave no hint of them from here.
      id: "environments",
      label: t("workspace.environments"),
      value: environments ?? "—",
    },
  ]

  return (
    <FeaturePageShell
      storageId="workspace"
      header={
        <FeaturePageHeader
          variant="management"
          title={workspace?.name ?? t("workspace.title")}
          summary={t("workspace.overview")}
          controls={
            /*
              The switcher belongs on the page about the workspace, not only in
              the desktop rail. On a phone that rail lives inside a nav sheet
              only `/` mounts, so this was the one workspace-shaped surface you
              could reach with no way to change which workspace it described.
              Same list the rail popover and the mobile drawer render.
            */
            <Popover open={switcherOpen} onOpenChange={setSwitcherOpen}>
              <PopoverTrigger asChild>
                <Button size="sm" variant="outline" data-testid="workspace-switcher-trigger">
                  <FolderIcon aria-hidden className="size-3.5" />
                  <span className="max-w-40 truncate">
                    {workspace?.name ?? tSwitcher("heading")}
                  </span>
                  <ChevronsUpDownIcon aria-hidden className="size-3.5 opacity-60" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80 p-1">
                <WorkspacePickerList
                  actions={pickerActions}
                  onSwitched={() => setSwitcherOpen(false)}
                />
              </PopoverContent>
            </Popover>
          }
        />
      }
    >
      <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col gap-4 p-4">
        <TabsList
          // `w-fit` alone let the four triggers add up to 406px inside a 375px
          // column, and the ancestor clipped the excess rather than scrolling
          // it, so "Source Control" could not be reached on a phone. Same
          // idiom the other narrow tab strips use.
          //
          // `shrink-0` because this sits in a `flex-col` with `min-h-0`: the
          // list's own `h-9` is a base size a flex child is free to shrink
          // below, and once the tab body had enough content the strip
          // compressed to its 3px padding and the labels vanished.
          className="w-fit max-w-full shrink-0 justify-start overflow-x-auto"
          aria-label={t("workspace.viewsLabel")}
        >
          <TabsTrigger value="overview">{t("workspace.overview")}</TabsTrigger>
          <TabsTrigger value="environments">{t("workspace.environments")}</TabsTrigger>
          <TabsTrigger value="capabilities">{tCapabilities("tab")}</TabsTrigger>
          <TabsTrigger value="source-control">{t("workspace.sourceControl")}</TabsTrigger>
        </TabsList>

        <TabsContent
          value="overview"
          className="mt-0 flex flex-col gap-3.5"
          data-testid="workspace-overview"
        >
          {/*
            The pane is the container, not the viewport. This page renders
            inside `FeaturePageShell`'s centre column, which on a wide window is
            still much narrower than the screen. Same reasoning the device
            detail and the settings panes write down.

            The strip lives INSIDE this element rather than above it: its column
            steps are `@xl/workspace-pane`, and a container query with no
            matching ancestor never fires, so the four tiles sat in two rows at
            every width.
          */}
          <div className="@container/workspace-pane flex flex-col gap-3.5">
            <StatStrip
              stats={stats}
              pane="workspace-pane"
              testId="workspace-stat-strip"
              cellTestIdPrefix="workspace-stat"
            />

            <div className="grid items-start gap-3.5 @3xl/workspace-pane:grid-cols-2">
              <ConsoleSection
                id="issues"
                pane="workspace-pane"
                idPrefix="workspace-section"
                title={t("workspace.issueSummary")}
                meta={counts.open}
                wide
              >
                <ul className="flex flex-wrap gap-2" data-testid="workspace-status-breakdown">
                  {ISSUE_STATUSES.map((status) => (
                    <li
                      key={status}
                      className="flex items-center gap-1.5 rounded-control border px-2.5 py-1.5 text-xs"
                      data-testid={`workspace-status-${status}`}
                    >
                      <IssueStatusIcon status={status} />
                      <span>{t(`status.${status}`)}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {counts.byStatus[status]}
                      </span>
                    </li>
                  ))}
                </ul>
              </ConsoleSection>

              <ConsoleSection
                id="projects"
                pane="workspace-pane"
                idPrefix="workspace-section"
                title={t("projects.title")}
                meta={(projects ?? []).length}
              >
                {(projects ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground" data-testid="workspace-no-projects">
                    {t("workspace.noProjects")}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {(projects ?? []).map((project) => (
                      <li key={project.id}>
                        <Link
                          href={`/projects?id=${encodeURIComponent(project.id)}`}
                          className="flex items-center gap-2 rounded-control border px-3 py-2 text-sm transition-colors hover:bg-accent/50"
                          data-testid={`workspace-project-${project.id}`}
                        >
                          <span aria-hidden>{project.icon ?? "📁"}</span>
                          <span className="min-w-0 flex-1 truncate">{project.name}</span>
                          <Badge variant="outline" className="font-mono text-[10px]">
                            {project.key}
                          </Badge>
                          <Badge variant="secondary" className="font-normal">
                            {t(`projects.status.${project.status}`)}
                          </Badge>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </ConsoleSection>

              <ConsoleSection
                id="roots"
                pane="workspace-pane"
                idPrefix="workspace-section"
                title={t("workspace.resources")}
                meta={
                  /*
                  Deliberately the existing manager dialog rather than inline
                  root editing. Workspace roots have exactly one editor, and the
                  trust gate lives on that path.
                */
                  <Button
                    size="sm"
                    variant="ghost"
                    className="-my-1 h-7"
                    onClick={() => setManageOpen(true)}
                    title={t("workspace.manageHint")}
                    data-testid="workspace-manage-link"
                  >
                    <SettingsIcon className="size-3.5" />
                    {t("workspace.manage")}
                  </Button>
                }
              >
                {workspace?.roots?.length ? (
                  <ul className="flex flex-col gap-1" data-testid="workspace-roots">
                    {workspace.roots.map((root) => {
                      const isTrusted = trustedPaths.has(normalizePath(root.path))
                      return (
                        <li
                          key={root.id}
                          className="flex items-center gap-2 rounded-control border px-3 py-2 text-xs"
                        >
                          <FolderIcon aria-hidden className="size-3.5 shrink-0" />
                          <span className="min-w-0 flex-1 truncate font-mono">{root.path}</span>
                          {root.isPrimary ? (
                            <Badge variant="secondary" className="text-[10px] font-normal">
                              1
                            </Badge>
                          ) : null}
                          <Badge
                            variant={isTrusted ? "secondary" : "outline"}
                            className="gap-1 text-[10px] font-normal"
                            data-testid={`workspace-root-trust-${isTrusted ? "trusted" : "untrusted"}`}
                          >
                            {isTrusted ? (
                              <ShieldCheckIcon aria-hidden className="size-3" />
                            ) : (
                              <ShieldOffIcon aria-hidden className="size-3" />
                            )}
                            {isTrusted ? t("workspace.trusted") : t("workspace.untrusted")}
                          </Badge>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">{t("projects.directoryHint")}</p>
                )}
              </ConsoleSection>

              {/* ADR-0149 section 4: the roster, and the only place a guest is
                visible to anybody but themselves. Reads the projection, so it
                never blocks on the network. */}
              <WorkspaceMembers workspaceId={workspaceId} />
              <WorkspaceActivity workspaceId={workspaceId} />
            </div>
          </div>
        </TabsContent>

        <TabsContent
          value="environments"
          className="mt-0 flex flex-col gap-4"
          data-testid="workspace-environments"
        >
          {/* Scoped to this Workspace. It used to list every environment on the
              machine, which on a laptop with several checked-out projects read
              as "this workspace owns all of these". Rows it does not own stay
              one click away. */}
          <WorkspaceEnvironmentList
            projectId={workspaceId ?? undefined}
            // The tab listed every environment and could create none: the only
            // creation entry in the app was inside the Source Control sheet.
            rootDir={primaryRoot}
            showCreate
          />

          {/*
            How this workspace's environments get provisioned, and what the repo
            itself declares. Both were reachable only from chat, through the
            session settings sheet, so the page about the workspace could show
            you the worktrees and not the rules that produce them. One
            component, a second door, not a second editor.
          */}
          {/*
            What isolated runs left behind. Branches outlive the directories
            above them, so after a run settles this is the only trace of what it
            did. It lived in a tab of the retired `/agent-teams/workspace`,
            where it was scoped to one squad's working directory rather than to
            the repository the branches actually pile up in.
          */}
          <AgentBranchesSection {...(primaryRoot ? { rootDir: primaryRoot } : {})} />

          {workspaceId && primaryRoot ? (
            <ProjectEnvironmentManager
              projectId={workspaceId}
              executionRoot={primaryRoot}
              scope="managedWorktree"
            />
          ) : null}
        </TabsContent>

        <TabsContent value="capabilities" className="mt-0">
          {/* Deltas only. The definitions stay in Settings. See the component. */}
          <WorkspaceCapabilities workspaceId={workspaceId} />
        </TabsContent>

        <TabsContent
          value="source-control"
          className="mt-0 min-h-0 flex-1 overflow-hidden rounded-panel border"
          data-testid="workspace-source-control"
        >
          <SourceControlPanel />
        </TabsContent>
      </Tabs>
      <WorkspaceManageDialog open={manageOpen} onOpenChange={setManageOpen} />
      {pickerDialogs}
    </FeaturePageShell>
  )
}
