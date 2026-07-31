"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  ArrowRightIcon,
  BookOpenTextIcon,
  FolderGit2Icon,
  FolderKanbanIcon,
  GitCompareArrowsIcon,
  MessageSquareTextIcon,
  RefreshCwIcon,
  SparklesIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { BranchHeader } from "@/components/source-control/branch-header"
import { ChangesView } from "@/components/source-control/changes-view"
import { RootSwitcher } from "@/components/source-control/root-switcher"
import { useGitActions } from "@/hooks/git/use-git-actions"
import { useGitRepo } from "@/hooks/git/use-git-repo"
import { primaryRootOf } from "@/lib/workspace/roots"
import { cn } from "@/lib/utils"
import { useGitStore } from "@/stores/git/git-store"
import { useProjectStore } from "@/stores/project/project-store"

interface ProjectOverviewPanelProps {
  projectId: string
  onOpenWorkspace: () => void
}

function basename(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] ?? path
}

export function ProjectOverviewPanel({ projectId, onOpenWorkspace }: ProjectOverviewPanelProps) {
  const t = useTranslations("projectOverview")
  const tSourceControl = useTranslations("sourceControl")
  const router = useRouter()
  const project = useProjectStore((state) =>
    state.projects.find((candidate) => candidate.id === projectId)
  )
  const { available, rootDir, refresh } = useGitRepo()
  const actions = useGitActions(refresh)
  const repoState = useGitStore((state) => state.repoState)
  const status = useGitStore((state) => state.status)
  const branches = useGitStore((state) => state.branches)
  const selectedPath = useGitStore((state) => state.selectedPath)
  const selectFile = useGitStore((state) => state.selectFile)
  const committing = useGitStore((state) => state.ops.commit)
  const syncing = useGitStore((state) => state.ops.sync)
  const setRootDir = useGitStore((state) => state.setRootDir)

  const roots = project?.roots ?? []
  const rootPaths = roots.map((root) => root.path)
  const primaryRoot = project ? primaryRootOf(project) : undefined
  const boundToProject = Boolean(rootDir && rootPaths.includes(rootDir))

  // This panel is resource-scoped: a background/split conversation may belong
  // to a different Project than the globally active one. Bind Git to that
  // conversation's own primary root on first activation, while preserving any
  // secondary root the user already selected inside the same Project.
  useEffect(() => {
    if (!primaryRoot || boundToProject) return
    setRootDir(primaryRoot.path)
  }, [boundToProject, primaryRoot, setRootDir])

  if (!project || roots.length === 0) return null

  const projectRepoState = boundToProject ? repoState : null
  const projectStatus = boundToProject ? status : null
  const changedCount = projectStatus
    ? projectStatus.merge.length + projectStatus.staged.length + projectStatus.changes.length
    : 0
  const contextConfiguredCount =
    Number(Boolean(project.description?.trim())) +
    Number(Boolean(project.customInstructions?.trim())) +
    Number(project.knowledgeBase.length > 0)
  const sessionCount = Math.max(project.sessionCount, project.sessionIds.length)

  let scmAnalysis = t("analysis.scmLoading")
  if (!available) scmAnalysis = t("analysis.scmUnavailable")
  else if (projectRepoState && !projectRepoState.isRepo) scmAnalysis = t("analysis.scmNotRepo")
  else if (projectStatus?.merge.length) {
    scmAnalysis = t("analysis.scmConflicts", { count: projectStatus.merge.length })
  } else if (projectStatus && changedCount > 0) {
    scmAnalysis = t("analysis.scmChanges", { count: changedCount })
  } else if (projectStatus) scmAnalysis = t("analysis.scmClean")

  return (
    <ScrollArea className="h-full" data-testid="project-overview-panel">
      <div className="space-y-5 p-4">
        <section className="overflow-hidden rounded-xl border bg-gradient-to-br from-primary/10 via-background to-background">
          <div className="space-y-3 p-4">
            <div className="flex items-start gap-3">
              <div className="rounded-lg bg-primary/10 p-2 text-primary">
                <FolderKanbanIcon className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <Badge variant="secondary" className="mb-1.5">
                  {t("workspaceBadge")}
                </Badge>
                <h2 className="truncate text-base font-semibold">{project.name}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {project.description?.trim() || t("noDescription")}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={onOpenWorkspace} data-testid="project-open-workspace">
                <FolderGit2Icon className="size-3.5" />
                {t("actions.openWorkspace")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!available}
                onClick={() => router.push("/source-control")}
                data-testid="project-open-source-control"
              >
                <GitCompareArrowsIcon className="size-3.5" />
                {t("actions.openSourceControl")}
              </Button>
            </div>
          </div>
        </section>

        <section aria-labelledby="project-overview-metrics">
          <h3
            id="project-overview-metrics"
            className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {t("summary.title")}
          </h3>
          <div className="grid grid-cols-2 gap-2">
            <Metric
              icon={<FolderGit2Icon className="size-3.5" />}
              label={t("summary.roots")}
              value={roots.length}
            />
            <Metric
              icon={<MessageSquareTextIcon className="size-3.5" />}
              label={t("summary.conversations")}
              value={sessionCount}
            />
            <Metric
              icon={<BookOpenTextIcon className="size-3.5" />}
              label={t("summary.knowledge")}
              value={project.knowledgeBase.length}
            />
            <Metric
              icon={<SparklesIcon className="size-3.5" />}
              label={t("summary.messages")}
              value={project.messageCount}
            />
          </div>
        </section>

        <section aria-labelledby="project-overview-analysis">
          <h3
            id="project-overview-analysis"
            className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {t("analysis.title")}
          </h3>
          <div className="divide-y rounded-lg border">
            <AnalysisRow
              label={t("analysis.contextLabel")}
              value={t("analysis.contextConfigured", {
                count: contextConfiguredCount,
                total: 3,
              })}
              healthy={contextConfiguredCount === 3}
            />
            <AnalysisRow
              label={t("analysis.scopeLabel")}
              value={
                roots.length > 1
                  ? t("analysis.multiRoot", { count: roots.length })
                  : t("analysis.singleRoot")
              }
              healthy
            />
            <AnalysisRow
              label={t("analysis.sourceControlLabel")}
              value={scmAnalysis}
              healthy={Boolean(projectStatus && projectStatus.merge.length === 0)}
            />
          </div>
        </section>

        <section aria-labelledby="project-overview-roots">
          <h3
            id="project-overview-roots"
            className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {t("roots.title")}
          </h3>
          <div className="space-y-1.5">
            {roots.map((root) => (
              <div
                key={root.id}
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-3 py-2",
                  root.path === rootDir && "border-primary/40 bg-primary/5"
                )}
              >
                <FolderGit2Icon className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {root.label || basename(root.path)}
                    </span>
                    {root.isPrimary && (
                      <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                        {t("roots.primary")}
                      </Badge>
                    )}
                  </div>
                  <p className="truncate text-xs text-muted-foreground" title={root.path}>
                    {root.path}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <Separator />

        <section className="space-y-3" aria-labelledby="project-overview-source-control">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="project-overview-source-control" className="text-sm font-semibold">
              {t("sourceControl.title")}
            </h3>
            <div className="flex items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                disabled={!available || !boundToProject}
                aria-label={tSourceControl("actions.refresh")}
                onClick={() => void refresh()}
                data-testid="project-refresh-source-control"
              >
                <RefreshCwIcon className="size-3.5" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!projectStatus || syncing}
                onClick={() => void actions.sync()}
                data-testid="project-sync-source-control"
              >
                <RefreshCwIcon className={cn("size-3.5", syncing && "animate-spin")} />
                {tSourceControl("actions.sync")}
              </Button>
            </div>
          </div>

          {available ? (
            <>
              <div className="flex min-w-0 items-center justify-between gap-1 rounded-lg border px-1.5 py-1">
                <RootSwitcher roots={roots} />
                <BranchHeader
                  branch={projectStatus?.branch ?? null}
                  ahead={projectStatus?.ahead ?? 0}
                  behind={projectStatus?.behind ?? 0}
                  branches={branches}
                  actions={actions}
                />
              </div>

              {projectRepoState && !projectRepoState.isRepo ? (
                <ScmNotice>{t("sourceControl.notRepository")}</ScmNotice>
              ) : projectStatus && changedCount > 0 ? (
                <div className="h-72 overflow-hidden rounded-lg border">
                  <ChangesView
                    variant="review"
                    rootDir={rootDir ?? primaryRoot?.path ?? roots[0]!.path}
                    status={projectStatus}
                    actions={actions}
                    committing={committing}
                    selectedPath={selectedPath}
                    onSelectFile={(path, staged) => {
                      selectFile(path, staged)
                      router.push("/source-control")
                    }}
                  />
                </div>
              ) : projectStatus ? (
                <ScmNotice>{t("sourceControl.clean")}</ScmNotice>
              ) : (
                <ScmNotice>{t("sourceControl.loading")}</ScmNotice>
              )}
            </>
          ) : (
            <ScmNotice>{t("sourceControl.unavailable")}</ScmNotice>
          )}

          <Button
            variant="ghost"
            className="w-full justify-between"
            disabled={!available}
            onClick={() => router.push("/source-control")}
          >
            {t("actions.openFullSourceControl")}
            <ArrowRightIcon className="size-4" />
          </Button>
        </section>
      </div>
    </ScrollArea>
  )
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="mb-2 flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
    </div>
  )
}

function AnalysisRow({
  label,
  value,
  healthy,
}: {
  label: string
  value: string
  healthy: boolean
}) {
  return (
    <div className="flex items-start gap-3 px-3 py-2.5">
      <span
        className={cn(
          "mt-1 size-2 shrink-0 rounded-full",
          healthy ? "bg-emerald-500" : "bg-amber-500"
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{value}</p>
      </div>
    </div>
  )
}

function ScmNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}
