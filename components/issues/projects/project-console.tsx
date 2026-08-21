"use client"

/**
 * `/projects` — delivery containers.
 *
 * NAMING: these are `IssueProject` rows, not the repo's `Project` (workspace)
 * entity. The route is `/projects` because that is what the user calls them;
 * the workspace lives at `/workspace`. See the invariant block in
 * `types/issues/index.ts` before touching either.
 *
 * This page was a dead end. It rendered a card grid and offered exactly one
 * mutation — binding and unbinding resources. `createIssueProject` was only
 * reachable from the create-issue dialog, and only on the branch that fires
 * when a workspace has NO container; `updateIssueProject` and
 * `deleteIssueProject` had no caller anywhere. The net effect was that a
 * workspace got exactly one container, ever, and none of its eight editable
 * fields could be changed after creation.
 *
 * It is now a master-detail console: a table that can actually be compared
 * across rows, an inspector that writes every field, create and delete.
 *
 * Resources stay reference-only. A `workspace-root` resource points at a root
 * already mounted on the owning workspace — this surface never mounts a
 * directory itself, because that would create a second directory source of
 * truth and bypass `lib/workspace/trust-gate.ts`.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { FolderIcon, RefreshCwIcon } from "lucide-react"
import { toast } from "sonner"

import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { useClientLiveQuery } from "@/hooks/data"
import { listIssues } from "@/lib/db/issues"
import {
  deleteIssueProject,
  listIssueProjects,
  removeIssueProjectResource,
  updateIssueProject,
  type IssueProjectUpdatePatch,
} from "@/lib/db/issue-projects"
import { syncGithubIssueSchedule } from "@/lib/issues/github-sync-schedule"
import { computeProgressFromIssues } from "@/lib/issues/project-progress"
import { isMissingGithubCredential, runWorkspaceGithubSync } from "@/lib/issues/sync-runner"
import { useProjectStore } from "@/stores/project/project-store"
import type { IssueProject } from "@/types/issues"
import { ProjectResourceDialog } from "../project-resource-dialog"
import { CreateProjectDialog } from "./create-project-dialog"
import { DeleteProjectDialog } from "./delete-project-dialog"
import { ProjectInspector } from "./project-inspector"
import { ProjectTable } from "./project-table"

export interface ProjectConsoleProps {
  /** Deep-linked project (`/projects?id=…`) — static export has no `[id]`. */
  initialSelectedId?: string
}

export function ProjectConsole({ initialSelectedId }: ProjectConsoleProps) {
  const t = useTranslations("issues")
  const router = useRouter()
  const workspaceId = useProjectStore((s) => s.activeProjectId)
  const workspaces = useProjectStore((s) => s.projects)
  const [selectedId, setSelectedId] = useState<string | undefined>(initialSelectedId)
  const [resourceForId, setResourceForId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<IssueProject | null>(null)
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
   * One pass over the issues the page already holds, rather than one query per
   * container. `computeIssueProjectProgress` exists for callers that hold only
   * an id; both now share the same tally.
   */
  const progressById = useMemo(
    () =>
      computeProgressFromIssues(
        (projects ?? []).map((project) => project.id),
        issues ?? []
      ),
    [projects, issues]
  )

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

  async function patchProject(id: string, patch: IssueProjectUpdatePatch) {
    try {
      await updateIssueProject(id, patch)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
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

  async function confirmDelete() {
    if (!deleteTarget) return
    try {
      await deleteIssueProject(deleteTarget.id)
      if (selectedId === deleteTarget.id) setSelectedId(undefined)
      // The container may have been the last one holding a repo binding.
      await syncGithubIssueSchedule()
      toast.success(t("projects.deleted", { name: deleteTarget.name }))
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDeleteTarget(null)
    }
  }

  return (
    <FeaturePageShell
      storageId="issue-projects"
      header={
        <FeaturePageHeader
          variant="management"
          icon={<FolderIcon />}
          title={t("projects.title")}
          summary={t("projects.summary", { count: (projects ?? []).length })}
          primaryAction={{
            id: "create",
            label: t("projects.create"),
            onSelect: () => setCreateOpen(true),
            disabled: !workspaceId,
            testId: "project-create-trigger",
          }}
          secondaryActions={[
            {
              id: "sync",
              label: syncing ? t("sync.running") : t("sync.now"),
              icon: RefreshCwIcon,
              onSelect: () => void syncNow(),
              disabled: !workspaceId || syncing || boundRepos.size === 0,
              testId: "project-sync-now",
            },
          ]}
        />
      }
      rightPane={
        selected
          ? {
              label: t("detail.properties"),
              defaultSize: 30,
              minSize: 22,
              maxSize: 46,
              content: (
                <ProjectInspector
                  project={selected}
                  progress={progressById.get(selected.id)}
                  onPatch={(patch) => void patchProject(selected.id, patch)}
                  onClose={() => setSelectedId(undefined)}
                  onAddResource={() => setResourceForId(selected.id)}
                  onRemoveResource={(index) => void removeResource(selected.id, index)}
                  onRequestDelete={() => setDeleteTarget(selected)}
                  onOpenIssues={() =>
                    router.push(`/issues?project=${encodeURIComponent(selected.id)}`)
                  }
                />
              ),
            }
          : undefined
      }
      centerClassName="min-h-0"
    >
      {(projects ?? []).length === 0 ? (
        <Empty data-testid="project-console-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderIcon />
            </EmptyMedia>
            <EmptyTitle>{t("projects.empty")}</EmptyTitle>
            <EmptyDescription>{t("projects.emptyHint")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ProjectTable
          projects={projects ?? []}
          progressById={progressById}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      )}

      {workspaceId ? (
        <CreateProjectDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          projectId={workspaceId}
          onCreated={(project) => setSelectedId(project.id)}
        />
      ) : null}

      <DeleteProjectDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        project={deleteTarget}
        issueCount={deleteTarget ? (progressById.get(deleteTarget.id)?.total ?? 0) : 0}
        onConfirm={confirmDelete}
      />

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
