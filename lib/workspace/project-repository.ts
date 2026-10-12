/**
 * A workspace's repository, read from its checkout (ADR-0224 A11).
 *
 * A workspace names folders on the device that created it. An always-on host
 * usually has none of them, so it needs the repository instead: it clones it
 * through the shared mirror cache with the git credential a paired device
 * stored for that git host. This module is where `Project.repository` comes
 * from, on a device that has the folder:
 *
 * - **Read, never typed.** The primary folder's `origin` (else its first
 *   remote), so the record says what the checkout really is.
 * - **Credential-free https.** An ssh or scp-style remote is recorded as its
 *   https form, a URL with a token in it loses the token, and a remote no host
 *   could clone over https (a local path, plain http) records nothing.
 * - **Kept when unreadable.** A folder that cannot be read right now (an
 *   unmounted disk, git missing) keeps what was recorded; a folder that reads
 *   and has no usable remote clears it.
 */

import { httpsRemoteUrl } from "@/lib/sandbox/remote-workspace"
import type { Project, ProjectRepository } from "@/types"

import { primaryRootOf } from "./roots"

export interface ProjectRepositoryReader {
  /**
   * `origin`'s fetch URL (else the first remote's) of the checkout at
   * `root`; `null` when it has none; throws when it cannot be read.
   */
  remoteOf(root: string): Promise<string | null>
  now(): number
}

/** What reading a workspace's checkout found. */
export type RepositoryReading =
  /** The folder could not be read; keep what is recorded. */
  | { kind: "unreadable" }
  /** The folder reads and has no remote a host could clone. */
  | { kind: "none" }
  | { kind: "found"; repository: ProjectRepository }

/** The https form of `remote`, or `undefined` when there is none. */
export function repositoryRemoteUrl(remote: string | null | undefined): string | undefined {
  return remote ? httpsRemoteUrl(remote) : undefined
}

export async function readProjectRepository(
  project: Pick<Project, "roots">,
  reader: ProjectRepositoryReader = defaultProjectRepositoryReader()
): Promise<RepositoryReading> {
  const root = primaryRootOf(project)?.path?.trim()
  if (!root) return { kind: "none" }
  let remote: string | null
  try {
    remote = await reader.remoteOf(root)
  } catch {
    return { kind: "unreadable" }
  }
  const remoteUrl = repositoryRemoteUrl(remote)
  return remoteUrl
    ? { kind: "found", repository: { remoteUrl, capturedAt: reader.now() } }
    : { kind: "none" }
}

/**
 * The `repository` to store after a reading: `undefined` to clear it, the
 * current record when nothing changed (so its `capturedAt` stays and no write
 * is made), or the new one.
 */
export function nextRepository(
  current: ProjectRepository | undefined,
  reading: RepositoryReading
): { changed: boolean; repository: ProjectRepository | undefined } {
  if (reading.kind === "unreadable") return { changed: false, repository: current }
  if (reading.kind === "none") return { changed: current !== undefined, repository: undefined }
  if (current?.remoteUrl === reading.repository.remoteUrl) {
    return { changed: false, repository: current }
  }
  return { changed: true, repository: reading.repository }
}

export interface CaptureProjectRepositoryDeps {
  reader?: ProjectRepositoryReader
  update(projectId: string, repository: ProjectRepository | undefined): void
}

/** Read the workspace's checkout and record its repository if it changed. */
export async function captureProjectRepository(
  project: Pick<Project, "id" | "roots" | "repository">,
  deps: CaptureProjectRepositoryDeps
): Promise<ProjectRepository | undefined> {
  const reading = await readProjectRepository(project, deps.reader)
  const next = nextRepository(project.repository, reading)
  if (next.changed) deps.update(project.id, next.repository)
  return next.repository
}

export function defaultProjectRepositoryReader(): ProjectRepositoryReader {
  return {
    remoteOf: async (root) => {
      const { gitRemotes } = await import("@/lib/git/commands")
      const remotes = await gitRemotes(root)
      const remote = remotes.find((entry) => entry.name === "origin") ?? remotes[0]
      return remote?.fetchUrl?.trim() || null
    },
    now: () => Date.now(),
  }
}
