"use client"

/**
 * `/projects` — delivery containers.
 *
 * NAMING: these are `IssueProject` rows, not the repo's `Project` (workspace)
 * entity. The route is `/projects` because that is what the user calls them;
 * the workspace lives at `/workspace`. See the invariant block in
 * `types/issues/index.ts` before touching either.
 *
 * Resources are reference-only. A `workspace-root` resource points at a root
 * already mounted on the owning workspace — this surface never mounts a
 * directory itself, because that would create a second directory source of
 * truth and bypass `lib/workspace/trust-gate.ts`.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { FolderGitIcon, FolderIcon, PlusIcon, RefreshCwIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { useClientLiveQuery } from "@/hooks/data"
import { listIssues } from "@/lib/db/issues"
import { listIssueProjects, removeIssueProjectResource } from "@/lib/db/issue-projects"
import { syncGithubIssueSchedule } from "@/lib/issues/github-sync-schedule"
import { isMissingGithubCredential, runWorkspaceGithubSync } from "@/lib/issues/sync-runner"
import { statusCategoryOf } from "@/types/issues"
import type { IssueProject } from "@/types/issues"
import { useProjectStore } from "@/stores/project/project-store"
import { cn } from "@/lib/utils"
import { ProjectResourceDialog } from "./project-resource-dialog"

export interface ProjectConsoleProps {
  /** Deep-linked project (`/projects?id=…`) — static export has no `[id]`. */
  initialSelectedId?: string
}

export function ProjectConsole({ initialSelectedId }: ProjectConsoleProps) {
  const t = useTranslations("issues")
  const workspaceId = useProjectStore((s) => s.activeProjectId)
  const workspaces = useProjectStore((s) => s.projects)
  const [selectedId, setSelectedId] = useState<string | undefined>(initialSelectedId)
  const [resourceForId, setResourceForId] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)

  /**
   * Mounted directories of the active workspace — the ONLY ones a container may
   * reference. Mounting is `lib/workspace/trust-gate.ts`'s job; this surface
   * never gains a second way in.
   */
  const roots = useMemo(
    () => workspaces.find((workspace) => workspace.id === workspaceId)?.roots ?? [],
    [workspaces, workspaceId]
  )

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

  /**
   * Progress per project, derived on read rather than stored so it can never
   * drift from the issues it summarises. Cancelled issues leave the
   * denominator — a cancelled item is not outstanding work.
   */
  const progressById = useMemo(() => {
    const map = new Map<string, { completed: number; total: number; ratio: number }>()
    for (const project of projects ?? []) map.set(project.id, { completed: 0, total: 0, ratio: 0 })
    for (const issue of issues ?? []) {
      const entry = map.get(issue.issueProjectId)
      if (!entry) continue
      const category = statusCategoryOf(issue.status)
      if (category === "canceled") continue
      entry.total += 1
      if (category === "completed") entry.completed += 1
    }
    for (const entry of map.values()) {
      entry.ratio = entry.total > 0 ? entry.completed / entry.total : 0
    }
    return map
  }, [projects, issues])

  const selected = (projects ?? []).find((project) => project.id === selectedId)

  /** Repos bound anywhere in this workspace — a repo may only be bound once. */
  const boundRepos = useMemo(
    () =>
      new Set(
        (projects ?? []).flatMap((project) =>
          project.resources
            .filter((resource) => resource.kind === "github-repo")
            .map((resource) => resource.repoFullName)
        )
      ),
    [projects]
  )
  const resourceTarget = (projects ?? []).find((project) => project.id === resourceForId)

  /**
   * Manual refresh. `full` bypasses the watermark, because the reason a user
   * reaches for this button is almost always that they suspect the incremental
   * path missed something.
   */
  async function syncNow() {
    if (!workspaceId) return
    setSyncing(true)
    try {
      const result = await runWorkspaceGithubSync({ projectId: workspaceId, full: true })
      if (result.repoCount === 0) {
        toast.info(t("sync.noRepos"))
      } else if (result.failures.length === 0) {
        const written = result.results.reduce((sum, repo) => sum + repo.written, 0)
        toast.success(t("sync.done", { count: written }))
      } else if (result.failures.every((failure) => isMissingGithubCredential(failure.error))) {
        // Worth its own message: "sync failed" would send the user looking for
        // a network problem that isn't there.
        toast.error(t("sync.noCredential"))
      } else {
        toast.error(
          t("sync.failed", {
            repos: result.failures.map((failure) => failure.repoFullName).join(", "),
          })
        )
      }
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSyncing(false)
    }
  }

  async function removeResource(projectId: string, index: number) {
    const project = (projects ?? []).find((candidate) => candidate.id === projectId)
    const resource = project?.resources[index]
    if (!resource) return
    await removeIssueProjectResource(projectId, resource)
    // Unbinding the last repo is what retires the background refresh.
    if (resource.kind === "github-repo") await syncGithubIssueSchedule()
  }

  return (
    <FeaturePageShell
      storageId="issue-projects"
      header={
        <FeaturePageHeader
          variant="management"
          title={t("projects.title")}
          summary={t("projects.summary", { count: (projects ?? []).length })}
          controls={
            <Button
              size="sm"
              variant="outline"
              onClick={syncNow}
              disabled={!workspaceId || syncing || boundRepos.size === 0}
              data-testid="project-sync-now"
            >
              <RefreshCwIcon className={cn("size-4", syncing && "animate-spin")} />
              {syncing ? t("sync.running") : t("sync.now")}
            </Button>
          }
        />
      }
      rightPane={
        selected
          ? {
              label: t("detail.properties"),
              content: (
                <ProjectInspector
                  project={selected}
                  progress={progressById.get(selected.id)}
                  onClose={() => setSelectedId(undefined)}
                  onAddResource={() => setResourceForId(selected.id)}
                  onRemoveResource={(index) => void removeResource(selected.id, index)}
                />
              ),
            }
          : undefined
      }
    >
      {(projects ?? []).length === 0 ? (
        <div
          className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center"
          data-testid="project-console-empty"
        >
          <FolderIcon aria-hidden className="size-8 text-muted-foreground/50" />
          <p className="text-sm font-medium">{t("projects.empty")}</p>
          <p className="max-w-sm text-xs text-muted-foreground">{t("projects.emptyHint")}</p>
        </div>
      ) : (
        <ul className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="project-console">
          {(projects ?? []).map((project) => {
            const progress = progressById.get(project.id)
            return (
              <li key={project.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(project.id)}
                  aria-pressed={selectedId === project.id}
                  data-testid={`project-card-${project.id}`}
                  className={cn(
                    "flex w-full flex-col gap-3 rounded-xl border bg-card p-4 text-left shadow-xs transition-shadow",
                    "hover:shadow-sm focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-[3px]",
                    selectedId === project.id && "ring-ring/60 ring-2"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span aria-hidden className="text-base">
                      {project.icon ?? "📁"}
                    </span>
                    <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
                      {project.name}
                    </h2>
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {project.key}
                    </Badge>
                  </div>

                  <Badge variant="secondary" className="w-fit font-normal">
                    {t(`projects.status.${project.status}`)}
                  </Badge>

                  {project.description ? (
                    <p className="line-clamp-2 text-xs text-muted-foreground">
                      {project.description}
                    </p>
                  ) : null}

                  <div className="flex items-center gap-2">
                    <Progress value={(progress?.ratio ?? 0) * 100} className="h-1.5 flex-1" />
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      {t("projects.progressCount", {
                        completed: progress?.completed ?? 0,
                        total: progress?.total ?? 0,
                      })}
                    </span>
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {resourceTarget ? (
        <ProjectResourceDialog
          open
          onOpenChange={(next) => {
            if (!next) setResourceForId(null)
          }}
          issueProjectId={resourceTarget.id}
          roots={roots}
          boundRepos={boundRepos}
          boundRootIds={
            new Set(
              resourceTarget.resources
                .filter((resource) => resource.kind === "workspace-root")
                .map((resource) => resource.rootId)
            )
          }
        />
      ) : null}
    </FeaturePageShell>
  )
}

function ProjectInspector({
  project,
  progress,
  onClose,
  onAddResource,
  onRemoveResource,
}: {
  project: IssueProject
  progress?: { completed: number; total: number; ratio: number }
  onClose: () => void
  onAddResource: () => void
  onRemoveResource: (index: number) => void
}) {
  const t = useTranslations("issues")

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="project-inspector">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <span aria-hidden>{project.icon ?? "📁"}</span>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{project.name}</h2>
        <Button size="sm" variant="ghost" onClick={onClose} data-testid="project-inspector-close">
          {t("detail.close")}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 text-sm">
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("detail.properties")}
          </h3>
          <Row label={t("detail.status")}>{t(`projects.status.${project.status}`)}</Row>
          <Row label={t("detail.priority")}>{t(`priority.${project.priority}`)}</Row>
          <Row label={t("projects.lead")}>
            {project.lead
              ? (project.lead.label ?? t(`actor.${project.lead.kind}`))
              : t("actor.noLead")}
          </Row>
          <Row label={t("projects.startDate")}>
            {project.startDate ? new Date(project.startDate).toLocaleDateString() : "—"}
          </Row>
          <Row label={t("projects.targetDate")}>
            {project.targetDate ? new Date(project.targetDate).toLocaleDateString() : "—"}
          </Row>
        </section>

        <Separator />

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("projects.progress")}
          </h3>
          <div className="flex items-center gap-2">
            <Progress value={(progress?.ratio ?? 0) * 100} className="h-2 flex-1" />
            <span className="text-xs tabular-nums text-muted-foreground">
              {t("projects.progressCount", {
                completed: progress?.completed ?? 0,
                total: progress?.total ?? 0,
              })}
            </span>
          </div>
        </section>

        <Separator />

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("projects.description")}
          </h3>
          {project.description ? (
            <p className="whitespace-pre-wrap leading-relaxed">{project.description}</p>
          ) : (
            <p className="text-xs italic text-muted-foreground">{t("projects.descriptionHint")}</p>
          )}
        </section>

        <Separator />

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("projects.resources")}
          </h3>
          {project.resources.length === 0 ? (
            <p className="text-xs italic text-muted-foreground">{t("projects.noResources")}</p>
          ) : (
            <ul className="flex flex-col gap-1.5" data-testid="project-resources">
              {project.resources.map((resource, index) => (
                <li
                  key={resource.kind === "github-repo" ? resource.repoFullName : resource.rootId}
                  className="flex items-center gap-2 text-xs"
                >
                  {resource.kind === "github-repo" ? (
                    <>
                      <FolderGitIcon aria-hidden className="size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate font-mono">
                        {resource.repoFullName}
                      </span>
                    </>
                  ) : (
                    <>
                      <FolderIcon aria-hidden className="size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{resource.rootId}</span>
                    </>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-6 shrink-0"
                    aria-label={t("projects.removeResource")}
                    onClick={() => onRemoveResource(index)}
                    data-testid={`project-resource-remove-${index}`}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <Button
            size="sm"
            variant="outline"
            className="w-fit"
            onClick={onAddResource}
            data-testid="project-add-resource"
          >
            <PlusIcon className="size-3.5" />
            {t("projects.addResource")}
          </Button>
          <p className="text-[11px] text-muted-foreground">{t("projects.directoryHint")}</p>
        </section>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}
