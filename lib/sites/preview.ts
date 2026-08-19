"use client"

import { getSiteEnvironmentRevision, getSiteProject } from "@/lib/db/sites"
import { readTextFile } from "@/lib/file/file-operations"
import { killFromDock, spawnFromDock, type SpawnOutcome } from "@/lib/terminal/spawn-orchestrator"
import { parseSiteHostingManifest } from "./manifest"
import { resolveSiteManifestPath, resolveSiteSourceDir } from "./manifest-file"
import { assertSiteAuthoringCapability } from "./authoring-policy"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

export interface SitePreviewSession {
  siteId: string
  terminalSessionId: string
  url: string
}

interface SitePreviewDeps {
  join: (...parts: string[]) => Promise<string>
  readText: typeof readTextFile
  spawn: (input: Parameters<typeof spawnFromDock>[0]) => Promise<SpawnOutcome>
  stop: (sessionId: string) => Promise<void>
  waitUntilReady: (url: string) => Promise<void>
  actorAccountId: string
}

const sessions = new Map<string, SitePreviewSession>()

async function defaultWaitUntilReady(url: string): Promise<void> {
  const deadline = Date.now() + 30_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "GET", cache: "no-store" })
      if (response.ok || response.type === "opaque") return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(
    `Site preview did not become ready: ${lastError instanceof Error ? lastError.message : "timeout"}`
  )
}

function defaults(): SitePreviewDeps {
  return {
    join: async (...parts) => {
      const path = await import("@tauri-apps/api/path")
      return path.join(...parts)
    },
    readText: readTextFile,
    spawn: spawnFromDock,
    stop: (sessionId) => killFromDock(sessionId, useTerminalStore.getState()),
    waitUntilReady: defaultWaitUntilReady,
    actorAccountId: "local-user",
  }
}

export async function startSitePreview(
  siteId: string,
  environmentRevisionId: string,
  dependencies?: Partial<SitePreviewDeps>
): Promise<SitePreviewSession> {
  const existing = sessions.get(siteId)
  if (existing) return existing
  const deps = { ...defaults(), ...dependencies }
  const site = await getSiteProject(siteId)
  if (
    !site ||
    site.lifecycle !== "active" ||
    (site.executionTarget as { kind?: unknown }).kind !== "local"
  ) {
    throw new Error("active local Site project not found")
  }
  assertSiteAuthoringCapability(site.authoringPolicy, deps.actorAccountId, "edit")
  const environment = await getSiteEnvironmentRevision(environmentRevisionId)
  if (!environment || environment.siteId !== site.id)
    throw new Error("Site environment revision not found")
  const sourceDir = await resolveSiteSourceDir(site, deps.join)
  const manifest = parseSiteHostingManifest(
    await deps.readText(await resolveSiteManifestPath(site, deps.join))
  )
  const [shell, ...args] = manifest.preview.command
  const outcome = await deps.spawn({
    req: {
      shell,
      args,
      cwd: sourceDir,
      env: environment.variables,
      rows: 24,
      cols: 100,
      projectId: site.projectId,
      enableShellIntegration: false,
      forceUtf8: true,
      origin: "local",
      sandboxed: true,
      sandboxNetwork: false,
    },
    store: useTerminalStore.getState(),
  })
  if (outcome.kind !== "spawned") {
    throw new Error(outcome.kind === "error" ? outcome.message : "Site preview spawn was denied")
  }
  try {
    await deps.waitUntilReady(manifest.preview.url)
  } catch (error) {
    await deps.stop(outcome.sessionId)
    throw error
  }
  const session = { siteId, terminalSessionId: outcome.sessionId, url: manifest.preview.url }
  sessions.set(siteId, session)
  return session
}

export async function stopSitePreview(
  siteId: string,
  dependencies?: Partial<Pick<SitePreviewDeps, "stop">>
): Promise<void> {
  const session = sessions.get(siteId)
  if (!session) return
  sessions.delete(siteId)
  await (dependencies?.stop ?? defaults().stop)(session.terminalSessionId)
}

export function getSitePreviewSession(siteId: string): SitePreviewSession | undefined {
  return sessions.get(siteId)
}

interface ResumePreviewDeps {
  join: SitePreviewDeps["join"]
  readText: SitePreviewDeps["readText"]
  listSessions: () => Array<{
    id: string
    projectId: string | null
    cwd: string | null
    status: "idle" | "running" | "exited"
  }>
}

/**
 * Re-adopt a preview whose in-memory record was lost.
 *
 * {@link sessions} is a module-level map, so navigating away from the console
 * and back — or any remount — used to reset step 4 to "not started" while the
 * dev server was still running, and the Stop button disappeared with it. The
 * terminal store still holds the spawned session, so the pairing can be
 * recovered from `projectId` + `cwd`.
 *
 * Terminal session rows are deliberately not persisted, so a full app restart
 * finds nothing here — which is correct: the PTY died with the process, and
 * "not started" is then the honest state.
 *
 * Never throws: a missing site, an unreadable manifest, or no matching terminal
 * all resolve to `undefined`.
 */
export async function resumeSitePreviewSession(
  siteId: string,
  dependencies?: Partial<ResumePreviewDeps>
): Promise<SitePreviewSession | undefined> {
  const existing = sessions.get(siteId)
  if (existing) return existing
  const base = defaults()
  const deps: ResumePreviewDeps = {
    join: base.join,
    readText: base.readText,
    listSessions: () => Object.values(useTerminalStore.getState().sessions),
    ...dependencies,
  }
  try {
    const site = await getSiteProject(siteId)
    if (!site || site.lifecycle !== "active") return undefined
    const sourceDir = await resolveSiteSourceDir(site, deps.join)
    const candidate = deps
      .listSessions()
      .find(
        (row) =>
          row.status !== "exited" && row.projectId === site.projectId && row.cwd === sourceDir
      )
    if (!candidate) return undefined
    const manifest = parseSiteHostingManifest(
      await deps.readText(await resolveSiteManifestPath(site, deps.join))
    )
    const session: SitePreviewSession = {
      siteId,
      terminalSessionId: candidate.id,
      url: manifest.preview.url,
    }
    sessions.set(siteId, session)
    return session
  } catch {
    return undefined
  }
}

export function __resetSitePreviewsForTesting(): void {
  sessions.clear()
}
