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

 * The open tab is a PROP, driven by `?tab=` in `app/workspace/page.tsx`. It was
 * `defaultValue="overview"`, which `FeaturePageShell` quietly undoes: it renders
 * its children through two different trees and remounts the subtree when the
 * breakpoint resolves, so an uncontrolled tab snapped back on the first resize.
 * A linkable tab is also what lets another surface point at Environments.
 *
 * The same rule is why the header's switcher is `WorkspacePickerList`, the
 * exact list the rail popover and the mobile drawer render, and why the
 * Environments tab mounts `ProjectEnvironmentManager` whole instead of its two
 * children: that component was reachable only from chat, through session
 * settings, so the repo-config and provisioning offers had no entry from the
 * page about the workspace they configure.
 *
 * Every dialog this page opens (the manager, the picker's footer) is a request
 * to the shell's one `WorkspaceDialogHost`. The page used to mount its own
 * manager AND the picker's copy of it, two instances of one editor.
 *
 * Each tab body is its own scroll container. Every ancestor from the app shell
 * down to `FeaturePageShell`'s centre column is `overflow-hidden`, so a tab
 * that did not scroll itself clipped whatever fell below the fold, and on the
 * desktop the provisioning rules under the environment list were unreachable.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import {
  ArrowUpRightIcon,
  ChevronsUpDownIcon,
  FolderIcon,
  GitBranchIcon,
  SettingsIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
} from "lucide-react"
import Link from "next/link"

import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { ResponsivePicker } from "@/components/shared/responsive-picker"
import { ConsoleSection } from "@/components/surface/console-section"
import { StatStrip, type StatStripItem } from "@/components/surface/stat-strip"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ProjectEnvironmentManager } from "@/components/settings/project-environment-manager"
import { listWorkspaceEnvironments } from "@/lib/task-workspace/client"
import { verdictNeedsAttention } from "@/lib/project-environment/workspace-config-trust"
import { cn } from "@/lib/utils"
import { useClientLiveQuery } from "@/hooks/data"
import { useIsMobile } from "@/hooks/ui/use-mobile"
import { useRepoWorkspaceConfig } from "@/hooks/workspace/use-repo-workspace-config"
import { listIssues } from "@/lib/db/issues"
import { listIssueProjects } from "@/lib/db/issue-projects"
import { listActiveAgentRuns, type ActiveAgentRun } from "@/lib/workspace/active-agent-runs"
import { listTrustedWorkspaces } from "@/lib/db/trusted-workspaces"
import { ISSUE_STATUSES, statusCategoryOf } from "@/types/issues"
import type { IssueProject, IssueStatus } from "@/types/issues"
import { useProjectStore } from "@/stores/project/project-store"
import { IssueStatusIcon } from "@/components/issues/issue-glyphs"
import { WorkspaceCapabilities } from "./workspace-capabilities"
import { WorkspaceMembers } from "./workspace-members"
import { WorkspaceActivity } from "./workspace-activity"
import { AgentBranchesSection } from "./agent-branches-section"
import { AGENTS_WORKING_REGION_ID, WorkspaceAgentsWorking } from "./workspace-agents-working"
import { WorkspaceEnvironmentList } from "./workspace-environment-list"
import { WorkspaceContextSummary } from "./workspace-context-summary"
import { WorkspaceRecentConversations } from "./workspace-recent-conversations"
import { WorkspaceSchedules } from "./workspace-schedules"
import { useWorkspacePickerRequests, WorkspacePickerList } from "./workspace-picker-list"

/**
 * A panel arriving, whether a tab body or the "agents working" list: a short
 * fade, scaled by the user's motion setting like every other in-app motion.
 * Reduced motion is honoured globally (`app/globals.css`).
 */
const PANEL_ENTER =
  "animate-in fade-in-0 [animation-duration:calc(160ms*var(--motion-duration-scale,1))]"
/** Tab bodies stay mounted while hidden, so the fade keys on becoming active. */
const TAB_ENTER =
  "data-[state=active]:animate-in data-[state=active]:fade-in-0 data-[state=active]:[animation-duration:calc(160ms*var(--motion-duration-scale,1))]"

/** Trailing-separator-insensitive, matching `lib/db/trusted-workspaces.ts`. */
function normalizePath(path: string): string {
  let p = path.trim()
  while (p.endsWith("/") || p.endsWith("\\")) p = p.slice(0, -1)
  return p
}

/**
 * The three views, in the order the strip renders them.
 *
 * `source-control` used to be a fourth, mounting the whole `SourceControlPanel`
 * inside this page. That put a `FeaturePageHeader` inside a `FeaturePageShell`,
 * and it bound a one-repository panel to a page whose entire thesis is the
 * workspace as the unit of work (ADR-0144), which can own several roots. It is
 * a link now. `app/workspace/page.tsx` redirects the old deep link.
 */
export const WORKSPACE_TABS = ["overview", "environments", "capabilities"] as const
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number]

export interface WorkspaceOverviewProps {
  /** From `?tab=`. Deep links survive a static export this way. */
  tab?: WorkspaceTab
  onTabChange?: (tab: WorkspaceTab) => void
}

export function WorkspaceOverview({ tab = "overview", onTabChange }: WorkspaceOverviewProps = {}) {
  const t = useTranslations("issues")
  // The Capabilities tab has its own namespace: it is about the workspace's
  // relationship to the skill/MCP libraries, not about issues.
  const tCapabilities = useTranslations("workspace.capabilities")
  const tSwitcher = useTranslations("workspace.switcher")
  const tManage = useTranslations("workspace.manage")
  const router = useRouter()
  const isMobile = useIsMobile()
  const workspaceId = useProjectStore((s) => s.activeProjectId)
  const workspaces = useProjectStore((s) => s.projects)
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [agentsOpen, setAgentsOpen] = useState(false)
  // Requests to the shell's dialog host: a Popover or Drawer unmounts its
  // children on close, so nothing the picker opens can live inside it.
  const pickerActions = useWorkspacePickerRequests()
  const openManage = useCallback(
    () => pickerActions.manage(workspaceId ?? undefined),
    [pickerActions, workspaceId]
  )

  const primaryRoot =
    workspace?.roots?.find((root) => root.isPrimary)?.path ?? workspace?.roots?.[0]?.path

  // A repository config waiting for approval changes what every turn here
  // runs, and its card sits at the bottom of a tab nobody opens by habit.
  const repoConfig = useRepoWorkspaceConfig(workspaceId, primaryRoot)
  const environmentsNeedAttention = verdictNeedsAttention(repoConfig.verdict)

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
  // One array feeds both the "Agents working" number and the list the tile
  // opens, so the two can never disagree.
  const activeAgentRuns = useClientLiveQuery(
    () => (workspaceId ? listActiveAgentRuns(workspaceId) : Promise.resolve([])),
    [workspaceId],
    [] as ActiveAgentRun[]
  )
  const agentsWorking = activeAgentRuns ?? []
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

  // `undefined` is a query still in flight. Rendering it as 0 said "no open
  // issues" for the first frames of every visit, and the Environments tile
  // beside it already said "unknown" for the same state.
  const unknown = t("workspace.unknownValue")
  const stats: StatStripItem[] = [
    {
      id: "open-issues",
      label: t("workspace.openIssues"),
      value: issues === undefined ? unknown : counts.open,
      // `/issues` is scoped to the active workspace, which is this one.
      action: { onSelect: () => router.push("/issues"), label: t("workspace.openIssuesOpen") },
    },
    {
      id: "projects",
      label: t("workspace.projectSummary"),
      value: projects === undefined ? unknown : projects.length,
      action: { onSelect: () => router.push("/projects"), label: t("workspace.projectsOpen") },
    },
    {
      id: "agents-working",
      label: t("workspace.agentsWorking"),
      value: activeAgentRuns === undefined ? unknown : agentsWorking.length,
      tone: agentsWorking.length > 0 ? "positive" : "neutral",
      action: {
        onSelect: () => setAgentsOpen((open) => !open),
        label: agentsOpen ? t("workspace.agentsWorkingHide") : t("workspace.agentsWorkingShow"),
        expanded: agentsOpen,
        controls: agentsOpen ? AGENTS_WORKING_REGION_ID : undefined,
      },
    },
    {
      // The fourth tile exists so the Environments tab is discoverable at all,
      // so it opens it rather than only counting it.
      id: "environments",
      label: t("workspace.environments"),
      value: environments ?? unknown,
      tone: environmentsNeedAttention ? "attention" : "neutral",
      action: {
        onSelect: () => onTabChange?.("environments"),
        label: t("workspace.environmentsOpen"),
      },
    },
  ]

  const switcherTrigger = (
    <Button size="sm" variant="outline" data-testid="workspace-switcher-trigger">
      <FolderIcon aria-hidden className="size-3.5" />
      <span className="max-w-40 truncate">{workspace?.name ?? tSwitcher("heading")}</span>
      <ChevronsUpDownIcon aria-hidden className="size-3.5 opacity-60" />
    </Button>
  )

  return (
    <FeaturePageShell
      storageId="workspace"
      header={
        <FeaturePageHeader
          variant="management"
          title={workspace?.name ?? t("workspace.title")}
          // The workspace's own description when it has one: the generic
          // tagline says what the page is, not what this workspace is for.
          summary={workspace?.description?.trim() || t("workspace.overview")}
          secondaryActions={[
            {
              id: "manage",
              label: t("workspace.manage"),
              icon: SettingsIcon,
              onSelect: openManage,
              disabled: !workspace,
              testId: "workspace-header-manage",
            },
          ]}
          controls={
            /*
              The switcher belongs on the page about the workspace, not only in
              the desktop rail. On a phone that rail lives inside a nav sheet
              only `/` mounts, so this was the one workspace-shaped surface you
              could reach with no way to change which workspace it described.
              Same list the rail popover and the mobile drawer render, in the
              same frame every picker wears: a popover, a bottom sheet on a
              phone.
            */
            <ResponsivePicker
              open={switcherOpen}
              onOpenChange={setSwitcherOpen}
              trigger={switcherTrigger}
              // Not "Workspaces": the list inside already carries that heading,
              // and the bottom sheet shows its title above it.
              title={tSwitcher("switchTitle")}
              variant="panel"
              align="end"
              side="bottom"
              contentClassName="w-72 p-1"
              commandClassName="px-2"
              testId="workspace-switcher-picker"
            >
              <WorkspacePickerList
                actions={pickerActions}
                density={isMobile ? "comfortable" : "compact"}
                onSwitched={() => setSwitcherOpen(false)}
              />
            </ResponsivePicker>
          }
        />
      }
    >
      {/* Controlled, not `defaultValue`. See the header. */}
      <Tabs
        value={tab}
        onValueChange={(next) => onTabChange?.(next as WorkspaceTab)}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        {/*
          The strip stays put while each tab body scrolls under it. `shrink-0`
          because this sits in a `flex-col` with `min-h-0`: the list's own `h-9`
          is a base size a flex child is free to shrink below, and once the tab
          body had enough content the strip compressed to its 3px padding and
          the labels vanished.
        */}
        <div className="@container/workspace-tabs flex shrink-0 items-center gap-2 px-4 pt-4 pb-3">
          <TabsList
            // `w-fit` alone let the triggers add up to more than a 375px
            // column, and the ancestor clipped the excess rather than
            // scrolling it. Same idiom the other narrow tab strips use.
            className="w-fit max-w-full min-w-0 justify-start overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            aria-label={t("workspace.viewsLabel")}
          >
            <TabsTrigger value="overview">{t("workspace.overview")}</TabsTrigger>
            <TabsTrigger value="environments" className="gap-1.5">
              {t("workspace.environments")}
              {environmentsNeedAttention ? (
                <span
                  className="size-1.5 shrink-0 rounded-full bg-amber-500"
                  role="img"
                  aria-label={t("workspace.environmentsAttention")}
                  data-testid="workspace-environments-attention"
                />
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="capabilities">{tCapabilities("tab")}</TabsTrigger>
          </TabsList>
          {/* Not a tab: it leaves the page. Beside the strip rather than in
              it, because a link is not a tab (`role="tablist"` admits only
              tabs, and arrow keys skipped it), and at phone width it was the
              part of the scrolling strip that fell off the edge. Removing a
              surface without leaving its entry point behind is how a feature
              becomes unreachable. */}
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="ml-auto h-7 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground"
            data-testid="workspace-source-control-link"
          >
            {/* The word gives way before the tabs do: at phone width the label
                pushed the last tab into a scroll the reader could not see. */}
            <Link href="/source-control" aria-label={t("workspace.sourceControl")}>
              <GitBranchIcon aria-hidden className="size-3.5 @[28rem]/workspace-tabs:hidden" />
              <span className="hidden @[28rem]/workspace-tabs:inline">
                {t("workspace.sourceControl")}
              </span>
              <ArrowUpRightIcon aria-hidden className="size-3" />
            </Link>
          </Button>
        </div>

        <TabsContent
          value="overview"
          className={cn("mt-0 min-h-0 flex-1 overflow-y-auto px-4 pb-6", TAB_ENTER)}
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

            {agentsOpen ? (
              <div className={PANEL_ENTER}>
                <WorkspaceAgentsWorking runs={agentsWorking} />
              </div>
            ) : null}

            <div className="grid items-start gap-3.5 @3xl/workspace-pane:grid-cols-2">
              <WorkspaceRecentConversations workspaceId={workspaceId} />
              <WorkspaceContextSummary workspace={workspace ?? null} onEdit={openManage} />

              <ConsoleSection
                id="issues"
                pane="workspace-pane"
                idPrefix="workspace-section"
                title={t("workspace.issueSummary")}
                meta={counts.open}
                wide
              >
                {issues === undefined ? (
                  <Skeleton className="h-7 w-full" data-testid="workspace-issues-loading" />
                ) : (
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
                )}
              </ConsoleSection>

              <WorkspaceSchedules workspaceId={workspaceId} />

              <ConsoleSection
                id="projects"
                pane="workspace-pane"
                idPrefix="workspace-section"
                title={t("projects.title")}
                meta={projects?.length}
              >
                {projects === undefined ? (
                  <Skeleton className="h-9 w-full" data-testid="workspace-projects-loading" />
                ) : projects.length === 0 ? (
                  <p className="text-xs text-muted-foreground" data-testid="workspace-no-projects">
                    {t("workspace.noProjects")}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {projects.map((project) => (
                      <li key={project.id}>
                        <Link
                          href={`/projects?id=${encodeURIComponent(project.id)}`}
                          className="flex items-center gap-2 rounded-control border px-3 py-2 text-sm transition-colors hover:bg-accent/50"
                          data-testid={`workspace-project-${project.id}`}
                        >
                          <span aria-hidden>{project.icon ?? "📁"}</span>
                          <span className="min-w-0 flex-1 truncate">{project.name}</span>
                          <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                            {project.key}
                          </Badge>
                          <Badge variant="secondary" className="shrink-0 font-normal">
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
                    onClick={openManage}
                    disabled={!workspace}
                    title={t("workspace.manageHint")}
                    data-testid="workspace-manage-link"
                  >
                    <SettingsIcon aria-hidden className="size-3.5" />
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
                          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-control border px-3 py-2 text-xs"
                        >
                          <FolderIcon aria-hidden className="size-3.5 shrink-0" />
                          <span
                            className="min-w-0 flex-1 basis-40 truncate font-mono"
                            title={root.path}
                          >
                            {root.label?.trim() && root.label.trim() !== root.path ? (
                              <>
                                <span className="font-sans font-medium">{root.label}</span>{" "}
                                <span className="text-muted-foreground">{root.path}</span>
                              </>
                            ) : (
                              root.path
                            )}
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            {root.isPrimary ? (
                              <Badge
                                variant="secondary"
                                className="text-[10px] font-normal uppercase"
                                data-testid="workspace-root-primary"
                              >
                                {tManage("primaryBadge")}
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
                          </span>
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
          className={cn(
            "mt-0 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-6",
            TAB_ENTER
          )}
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
            What isolated runs left behind. Branches outlive the directories
            above them, so after a run settles this is the only trace of what it
            did. It lived in a tab of the retired `/agent-teams/workspace`,
            where it was scoped to one squad's working directory rather than to
            the repository the branches actually pile up in.
          */}
          <AgentBranchesSection {...(primaryRoot ? { rootDir: primaryRoot } : {})} />

          {/*
            How this workspace's environments get provisioned, and what the repo
            itself declares. Both were reachable only from chat, through the
            session settings sheet, so the page about the workspace could show
            you the worktrees and not the rules that produce them. One
            component, a second door, not a second editor.
          */}
          {workspaceId && primaryRoot ? (
            <ProjectEnvironmentManager
              projectId={workspaceId}
              executionRoot={primaryRoot}
              scope="managedWorktree"
            />
          ) : null}
        </TabsContent>

        <TabsContent
          value="capabilities"
          className={cn("mt-0 min-h-0 flex-1 overflow-y-auto px-4 pb-6", TAB_ENTER)}
        >
          {/* Deltas only. The definitions stay in Settings. See the component. */}
          <WorkspaceCapabilities workspaceId={workspaceId} />
        </TabsContent>
      </Tabs>
    </FeaturePageShell>
  )
}
