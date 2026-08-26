"use client"

/**
 * `/workspace` — the current workspace at a glance.
 *
 * "Workspace" here is the repo's existing `Project` entity (`lib/db/projects.ts`,
 * user-facing label "Workspace"), NOT a new container and NOT the tracker's
 * `IssueProject`. This page exists to give that entity a real home: its
 * delivery containers, its issue totals, and the roots it has mounted.
 *
 * Hard constraint: this must not become a SECOND place that edits workspace
 * roots. `components/shell/workspace-manage-dialog.tsx` already owns those
 * mutations, so this surface MOUNTS THAT SAME DIALOG behind its "Manage"
 * button rather than duplicating the controls — one editor component, two
 * entry points (here and the switcher). Two editors over one row is the
 * "double entry point" defect this repo keeps re-learning; two doors into
 * one editor is fine.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { FolderIcon, SettingsIcon, ShieldCheckIcon, ShieldOffIcon } from "lucide-react"
import Link from "next/link"

import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { WorkspaceManageDialog } from "@/components/shell/workspace-manage-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SourceControlPanel } from "@/components/source-control/source-control-panel"
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
import { WorkspaceEnvironmentList } from "./workspace-environment-list"

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
  const workspaceId = useProjectStore((s) => s.activeProjectId)
  const workspaces = useProjectStore((s) => s.projects)
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId)
  const [manageOpen, setManageOpen] = useState(false)

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

  return (
    <FeaturePageShell
      storageId="workspace"
      header={
        <FeaturePageHeader
          variant="management"
          title={workspace?.name ?? t("workspace.title")}
          summary={t("workspace.overview")}
        />
      }
    >
      <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col gap-4 p-4">
        <TabsList className="w-fit" aria-label={t("workspace.viewsLabel")}>
          <TabsTrigger value="overview">{t("workspace.overview")}</TabsTrigger>
          <TabsTrigger value="environments">{t("workspace.environments")}</TabsTrigger>
          <TabsTrigger value="capabilities">{tCapabilities("tab")}</TabsTrigger>
          <TabsTrigger value="source-control">{t("workspace.sourceControl")}</TabsTrigger>
        </TabsList>

        <TabsContent
          value="overview"
          className="mt-0 flex flex-col gap-6"
          data-testid="workspace-overview"
        >
          <section className="grid gap-3 sm:grid-cols-3">
            <StatTile
              label={t("workspace.openIssues")}
              value={counts.open}
              testId="workspace-open-issues"
            />
            <StatTile
              label={t("workspace.projectSummary")}
              value={(projects ?? []).length}
              testId="workspace-project-count"
            />
            <StatTile
              label={t("workspace.agentsWorking")}
              value={runningIssueIds?.size ?? 0}
              testId="workspace-agents-working"
            />
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("workspace.issueSummary")}
            </h2>
            <ul className="flex flex-wrap gap-2" data-testid="workspace-status-breakdown">
              {ISSUE_STATUSES.map((status) => (
                <li
                  key={status}
                  className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs"
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
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("projects.title")}
            </h2>
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
                      className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-accent/50"
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
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("workspace.resources")}
              </h2>
              <span className="flex-1" />
              {/*
              Deliberately the existing manager dialog rather than inline root
              editing: workspace roots have exactly one editor, and the trust
              gate lives on that path.
            */}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setManageOpen(true)}
                title={t("workspace.manageHint")}
                data-testid="workspace-manage-link"
              >
                <SettingsIcon className="size-4" />
                {t("workspace.manage")}
              </Button>
            </div>
            {workspace?.roots?.length ? (
              <ul className="flex flex-col gap-1" data-testid="workspace-roots">
                {workspace.roots.map((root) => {
                  const isTrusted = trustedPaths.has(normalizePath(root.path))
                  return (
                    <li
                      key={root.id}
                      className="flex items-center gap-2 rounded-lg border px-3 py-2 text-xs"
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
          </section>
          {/* ADR-0149 §4 — the roster, and the only place a guest is visible
              to anybody but themselves. Reads the projection, so it never
              blocks on the network. */}
          <WorkspaceMembers workspaceId={workspaceId} />
        </TabsContent>

        <TabsContent value="environments" className="mt-0" data-testid="workspace-environments">
          {/* Scoped to this Workspace. It used to list every environment on the
              machine, which on a laptop with several checked-out projects read
              as "this workspace owns all of these". Rows it does not own stay
              one click away. */}
          <WorkspaceEnvironmentList projectId={workspaceId ?? undefined} />
        </TabsContent>

        <TabsContent value="capabilities" className="mt-0">
          {/* Deltas only — the definitions stay in Settings. See the component. */}
          <WorkspaceCapabilities workspaceId={workspaceId} />
        </TabsContent>

        <TabsContent
          value="source-control"
          className="mt-0 min-h-0 flex-1 overflow-hidden rounded-lg border"
          data-testid="workspace-source-control"
        >
          <SourceControlPanel />
        </TabsContent>
      </Tabs>
      <WorkspaceManageDialog open={manageOpen} onOpenChange={setManageOpen} />
    </FeaturePageShell>
  )
}

function StatTile({ label, value, testId }: { label: string; value: number; testId: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border bg-card p-4" data-testid={testId}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
    </div>
  )
}
