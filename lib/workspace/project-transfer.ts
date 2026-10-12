/**
 * A workspace moving to an always-on host with the work bound to it
 * (ADR-0224 A11).
 *
 * Workspaces do not sync between devices, so a scheduled task or Bot bound to
 * one used to be refused on the way to a host: the host had no such workspace,
 * and its folders were on this machine's disk. A workspace with a repository
 * (`Project.repository`) can go along instead. The host gets a copy under the
 * same id, with the folders as this device names them and the repository the
 * host clones when it has none of them (`host-project-source.ts`).
 *
 * The copy is written by `project_mutate` on the host. It carries only what
 * locating the code needs: its name and description so it reads the same in
 * both places, its folders and its repository. Conversations, knowledge files
 * and settings stay where they are. The Default workspace never moves: every
 * device has its own under the same id.
 */

import { DEFAULT_PROJECT_ID } from "@/lib/db/project-defaults"
import { repositoryRemoteUrl } from "@/lib/workspace/project-repository"
import type { Project, ProjectRepository } from "@/types"
import type { WorkspaceRoot } from "@/types/workspace"

const MAX_ID = 256
const MAX_NAME = 200
const MAX_DESCRIPTION = 4_000
const MAX_ROOTS = 32
const MAX_PATH = 4_096

/** What the host is given of a workspace. */
export interface TransferredProject {
  id: string
  name: string
  description?: string
  roots: Pick<WorkspaceRoot, "path" | "label" | "isPrimary">[]
  repository: ProjectRepository
}

export interface ProjectMutateArgs {
  operation: "upsert"
  /** Ties a resend to the move that sent it. */
  operationId: string
  project: TransferredProject
}

export interface ProjectMutateResult {
  id: string
  created: boolean
}

/** Whether `project` can go to a host with its work. */
export function canTransferProject(
  project: Pick<Project, "id" | "repository"> | null | undefined
): project is Pick<Project, "id"> & { repository: ProjectRepository } {
  return Boolean(project && project.id !== DEFAULT_PROJECT_ID && project.repository?.remoteUrl)
}

/** The host's copy of `project`; `null` for one that cannot go. */
export function transferredProject(project: Project): TransferredProject | null {
  if (!canTransferProject(project)) return null
  return {
    id: project.id,
    name: project.name,
    ...(project.description ? { description: project.description } : {}),
    roots: project.roots.map((root) => ({
      path: root.path,
      ...(root.label ? { label: root.label } : {}),
      isPrimary: root.isPrimary,
    })),
    repository: project.repository,
  }
}

class ProjectMutateError extends Error {
  readonly code = "invalid_argument"
  constructor(message: string) {
    super(message)
    this.name = "ProjectMutateError"
  }
}

function text(value: unknown, field: string, max: number, required = true): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new ProjectMutateError(`${field} is required`)
    return undefined
  }
  if (typeof value !== "string") throw new ProjectMutateError(`${field} must be a string`)
  const trimmed = value.trim()
  if (required && !trimmed) throw new ProjectMutateError(`${field} must not be empty`)
  if (trimmed.length > max) throw new ProjectMutateError(`${field} is longer than ${max}`)
  return trimmed || undefined
}

/** Check `project_mutate`'s arguments the way the host must: nothing is trusted. */
export function parseProjectMutate(raw: unknown): ProjectMutateArgs {
  const args = (raw ?? {}) as Record<string, unknown>
  if (args.operation !== "upsert") {
    throw new ProjectMutateError("operation must be upsert")
  }
  const operationId = text(args.operationId, "operationId", MAX_ID)!
  const project = (args.project ?? {}) as Record<string, unknown>
  const id = text(project.id, "project.id", MAX_ID)!
  if (id === DEFAULT_PROJECT_ID) {
    throw new ProjectMutateError("the Default workspace is each device's own and cannot move")
  }
  const name = text(project.name, "project.name", MAX_NAME)!
  const description = text(project.description, "project.description", MAX_DESCRIPTION, false)
  if (!Array.isArray(project.roots) || project.roots.length > MAX_ROOTS) {
    throw new ProjectMutateError(`project.roots must be a list of at most ${MAX_ROOTS}`)
  }
  const roots = project.roots.map((entry, index) => {
    const root = (entry ?? {}) as Record<string, unknown>
    const path = text(root.path, `project.roots[${index}].path`, MAX_PATH)!
    const label = text(root.label, `project.roots[${index}].label`, MAX_NAME, false)
    return { path, ...(label ? { label } : {}), isPrimary: root.isPrimary === true }
  })
  const repository = (project.repository ?? {}) as Record<string, unknown>
  const remoteUrl = text(repository.remoteUrl, "project.repository.remoteUrl", MAX_PATH)!
  // Only the form a device records: https, no credential, nothing to normalize.
  if (repositoryRemoteUrl(remoteUrl) !== remoteUrl) {
    throw new ProjectMutateError("project.repository.remoteUrl must be a credential-free https URL")
  }
  const capturedAt = repository.capturedAt
  if (typeof capturedAt !== "number" || !Number.isFinite(capturedAt)) {
    throw new ProjectMutateError("project.repository.capturedAt must be a number")
  }
  return {
    operation: "upsert",
    operationId,
    project: {
      id,
      name,
      ...(description ? { description } : {}),
      roots,
      repository: { remoteUrl, capturedAt },
    },
  }
}

/** The project store's writes `project_mutate` uses. */
export interface ProjectMutateStore {
  find(id: string): Project | undefined
  create(project: TransferredProject): void
  update(project: TransferredProject): void
}

/**
 * `project_mutate` on the host: create the copy, or bring an existing copy's
 * name, folders and repository up to date. A resend is a no-op beyond that.
 */
export async function applyProjectMutate(
  raw: unknown,
  store?: ProjectMutateStore
): Promise<ProjectMutateResult> {
  const { project } = parseProjectMutate(raw)
  const target = store ?? (await loadProjectMutateStore())
  if (target.find(project.id)) {
    target.update(project)
    return { id: project.id, created: false }
  }
  target.create(project)
  return { id: project.id, created: true }
}

function rootsOf(project: TransferredProject): WorkspaceRoot[] {
  return project.roots.map((root, index) => ({
    id: `transferred-${index}`,
    path: root.path,
    ...(root.label ? { label: root.label } : {}),
    isPrimary: root.isPrimary,
  }))
}

/** The project store, loaded on first use: a pure caller does not need it. */
export async function loadProjectMutateStore(): Promise<ProjectMutateStore> {
  const { useProjectStore } = await import("@/stores/project/project-store")
  return {
    find: (id) => useProjectStore.getState().projects.find((project) => project.id === id),
    create: (project) => {
      useProjectStore.getState().createProject({
        id: project.id,
        name: project.name,
        description: project.description,
        roots: rootsOf(project),
        repository: project.repository,
      })
    },
    update: (project) => {
      useProjectStore.getState().updateProject(project.id, {
        name: project.name,
        description: project.description,
        roots: rootsOf(project),
        repository: project.repository,
      })
    },
  }
}
