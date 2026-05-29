import { getDb } from "./schema"

/**
 * Computer-Use sandbox connection registry (ADR-0020 remote-target addendum).
 *
 * A `sandboxConnection` is a first-class entity describing one cua desktop
 * sandbox (Phase 1: a local Docker `ghcr.io/trycua/cua-xfce` container running
 * `computer-server`). Target selectors on `Character` / `ChatSession` /
 * workflow nodes reference a row by `id` — this id is the convergence anchor
 * that lets a future ADR-0028 `cua-desktop` tier reuse the same binding without
 * data migration.
 */

/** Phase 1 ships `docker`; `cloud` / `lume` are reserved for later providers. */
export type SandboxProvider = "docker"

export type SandboxHealthStatus = "unknown" | "starting" | "ok" | "unreachable" | "error"

export interface SandboxConnectionRow {
  /** uuid primary key — the value target selectors reference. */
  id: string
  /** User-visible label, e.g. "home-docker". */
  name: string
  provider: SandboxProvider
  /** Docker image, default `ghcr.io/trycua/cua-xfce:latest`. */
  image: string
  /** Host the container is reachable on (Phase 1 always `127.0.0.1`). */
  host: string
  /** Mapped host port for the container's `computer-server` :8000; 0 until started. */
  port: number
  /** Docker container id once running. */
  containerId?: string
  lastHealthStatus: SandboxHealthStatus
  lastHealthError?: string
  lastHealthCheckAt?: number
  createdAt: number
  updatedAt: number
}

/** Newest-first by `createdAt`. */
export async function listSandboxConnections(): Promise<SandboxConnectionRow[]> {
  const rows = await getDb().sandboxConnections.toArray()
  return rows.sort((a, b) => b.createdAt - a.createdAt)
}

export async function getSandboxConnection(id: string): Promise<SandboxConnectionRow | undefined> {
  return getDb().sandboxConnections.get(id)
}

export async function putSandboxConnection(row: SandboxConnectionRow): Promise<void> {
  await getDb().sandboxConnections.put(row)
}

export async function deleteSandboxConnection(id: string): Promise<void> {
  await getDb().sandboxConnections.delete(id)
}
