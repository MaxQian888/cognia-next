import { nanoid } from "nanoid"

import { canonicalStringify } from "@/lib/data/migrate"
import {
  appendSiteBuildPhaseEvent,
  claimSiteOperation,
  completeSiteOperation,
  completeSiteVersion,
  createSiteVersionDraft,
  failSiteOperation,
  failSiteVersion,
  getSiteEnvironmentRevision,
  getSiteProject,
  putSiteArtifact,
  putSiteBuildLog,
  queueSiteOperation,
} from "@/lib/db/sites"
import { exists, readBinaryFile, readTextFile } from "@/lib/file/file-operations"
import { sha256Bytes } from "@/lib/ocr/hash"
import { sha256Hex } from "@/lib/share/hash"
import { packageSiteArtifact, type SiteArtifactFile } from "./artifact-package"
import { buildLogRowFrom, buildPhaseMessage } from "./build-log"
import { assertSiteAuthoringCapability } from "./authoring-policy"
import { runConfinedSiteBuild, type ConfinedSiteBuildResult } from "./confined-build"
import { parseSiteHostingManifest } from "./manifest"
import { resolveSiteManifestPath, resolveSiteSourceDir } from "./manifest-file"
import type { SiteBuildPhase, SiteVersionRow } from "@/types/sites"
import type { GitCommit, GitStatus } from "@/types/git"

interface LocalEntry {
  name: string
  isFile: boolean
  isDirectory: boolean
  isSymlink: boolean
}

interface BuildVersionDeps {
  now: () => number
  newId: (prefix: string) => string
  leaseOwner: string
  join: (...parts: string[]) => Promise<string>
  readText: typeof readTextFile
  readBytes: typeof readBinaryFile
  pathExists: typeof exists
  readDir: (path: string) => Promise<LocalEntry[]>
  gitSnapshot: (repoPath: string) => Promise<{ commit: GitCommit | undefined; status: GitStatus }>
  runBuild: typeof runConfinedSiteBuild
  getSite: typeof getSiteProject
  getEnvironment: typeof getSiteEnvironmentRevision
  createDraft: typeof createSiteVersionDraft
  queueOperation: typeof queueSiteOperation
  claimOperation: typeof claimSiteOperation
  putArtifact: typeof putSiteArtifact
  completeVersion: typeof completeSiteVersion
  completeOperation: typeof completeSiteOperation
  failVersion: typeof failSiteVersion
  failOperation: typeof failSiteOperation
  appendPhaseEvent: typeof appendSiteBuildPhaseEvent
  putBuildLog: typeof putSiteBuildLog
}

async function defaultGitSnapshot(
  repoPath: string
): Promise<{ commit: GitCommit | undefined; status: GitStatus }> {
  const { invoke } = await import("@tauri-apps/api/core")
  const [commits, status] = await Promise.all([
    invoke<GitCommit[]>("git_log", { repoPath, maxCount: 1, skip: 0 }),
    invoke<GitStatus>("git_status", { repoPath }),
  ])
  return { commit: commits[0], status }
}

function defaults(): BuildVersionDeps {
  return {
    now: Date.now,
    newId: (prefix) => `${prefix}_${nanoid()}`,
    leaseOwner: `sites-build-${nanoid()}`,
    join: async (...parts) => {
      const path = await import("@tauri-apps/api/path")
      return path.join(...parts)
    },
    readText: readTextFile,
    readBytes: readBinaryFile,
    pathExists: exists,
    readDir: async (path) => {
      const fs = await import("@tauri-apps/plugin-fs")
      return (await fs.readDir(path)).map((entry) => ({
        name: entry.name,
        isFile: entry.isFile,
        isDirectory: entry.isDirectory,
        isSymlink: entry.isSymlink,
      }))
    },
    gitSnapshot: defaultGitSnapshot,
    runBuild: runConfinedSiteBuild,
    getSite: getSiteProject,
    getEnvironment: getSiteEnvironmentRevision,
    createDraft: createSiteVersionDraft,
    queueOperation: queueSiteOperation,
    claimOperation: claimSiteOperation,
    putArtifact: putSiteArtifact,
    completeVersion: completeSiteVersion,
    completeOperation: completeSiteOperation,
    failVersion: failSiteVersion,
    failOperation: failSiteOperation,
    appendPhaseEvent: appendSiteBuildPhaseEvent,
    putBuildLog: putSiteBuildLog,
  }
}

function failure(result: ConfinedSiteBuildResult, phase: string): Error | undefined {
  if (result.timedOut) return new Error(`Site ${phase} timed out`)
  if (result.exitCode !== 0) {
    return new Error(result.stderr.trim() || result.stdout.trim() || `Site ${phase} failed`)
  }
  return undefined
}

async function collectTree(
  root: string,
  relative: string,
  deps: Pick<BuildVersionDeps, "join" | "readDir" | "readBytes">
): Promise<SiteArtifactFile[]> {
  const absolute = await deps.join(root, ...relative.split("/"))
  const entries = (await deps.readDir(absolute)).sort((left, right) =>
    left.name.localeCompare(right.name)
  )
  const files: SiteArtifactFile[] = []
  for (const entry of entries) {
    if (entry.isSymlink) throw new Error(`Site build output cannot contain symlinks: ${entry.name}`)
    const child = `${relative}/${entry.name}`
    if (entry.isDirectory) files.push(...(await collectTree(root, child, deps)))
    else if (entry.isFile) {
      files.push({
        path: child,
        bytes: await deps.readBytes(await deps.join(root, ...child.split("/"))),
      })
    }
  }
  return files
}

export async function collectSiteBuildOutput(
  input: { sourceDir: string; entry: string; assets?: string },
  dependencies?: Partial<Pick<BuildVersionDeps, "join" | "readDir" | "readBytes">>
): Promise<SiteArtifactFile[]> {
  const base = defaults()
  const deps = {
    join: base.join,
    readDir: base.readDir,
    readBytes: base.readBytes,
    ...dependencies,
  }
  const files: SiteArtifactFile[] = [
    {
      path: input.entry,
      bytes: await deps.readBytes(await deps.join(input.sourceDir, ...input.entry.split("/"))),
    },
  ]
  if (input.assets) files.push(...(await collectTree(input.sourceDir, input.assets, deps)))
  return [...new Map(files.map((file) => [file.path, file])).values()]
}

export interface BuildAndSaveSiteVersionInput {
  siteId: string
  environmentRevisionId: string
  runtime: string
  packageManager: string
  installNetworkHosts?: string[]
  buildNetworkHosts?: string[]
  actorAccountId?: string
}

export async function buildAndSaveSiteVersion(
  input: BuildAndSaveSiteVersionInput,
  dependencies?: Partial<BuildVersionDeps>
): Promise<SiteVersionRow> {
  const deps = { ...defaults(), ...dependencies }
  const site = await deps.getSite(input.siteId)
  if (!site || site.lifecycle !== "active") throw new Error("active site project not found")
  assertSiteAuthoringCapability(site.authoringPolicy, input.actorAccountId ?? "local-user", "edit")
  if ((site.executionTarget as { kind?: unknown }).kind !== "local") {
    throw new Error("Sites builds require the selected local execution host")
  }
  const environment = await deps.getEnvironment(input.environmentRevisionId)
  if (!environment || environment.siteId !== site.id)
    throw new Error("Site environment revision not found")
  const sourceDir = await resolveSiteSourceDir(site, deps.join)
  const manifest = parseSiteHostingManifest(
    await deps.readText(await resolveSiteManifestPath(site, deps.join))
  )
  const git = await deps.gitSnapshot(site.sourceRoot)
  const dirty = [...git.status.staged, ...git.status.changes, ...git.status.merge].length > 0
  const lockfiles = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb", "Cargo.lock"]
  let lockfileDigest = await sha256Hex("no-lockfile")
  for (const name of lockfiles) {
    const path = await deps.join(site.sourceRoot, name)
    if (await deps.pathExists(path)) {
      lockfileDigest = await sha256Bytes(await deps.readBytes(path))
      break
    }
  }
  const source = {
    commitSha: git.commit?.hash ?? "unversioned",
    dirty,
    lockfileDigest,
    inputDigest: await sha256Hex(
      canonicalStringify({
        manifest,
        commitSha: git.commit?.hash ?? "unversioned",
        changedPaths: [...git.status.staged, ...git.status.changes, ...git.status.merge]
          .map((change) => change.path)
          .sort(),
      })
    ),
  }
  const versionId = deps.newId("siteversion")
  let version: SiteVersionRow
  try {
    version = await deps.createDraft({
      id: versionId,
      siteId: site.id,
      environmentRevisionId: environment.id,
      source,
      build: {
        command: JSON.stringify(manifest.build.command),
        runtime: input.runtime,
        packageManager: input.packageManager,
        compatibilityDate: manifest.cloudflare.compatibilityDate,
        compatibilityFlags: manifest.cloudflare.compatibilityFlags,
        routes: [],
        bindings: manifest.cloudflare.bindings.map((binding) => ({
          kind: binding.kind,
          name: binding.name,
          resourceId: binding.providerResourceId,
        })),
      },
      now: deps.now(),
    })
  } catch (error) {
    throw new Error(
      `Unable to create Site version draft: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
  const operationId = deps.newId("siteop")
  await deps.queueOperation({
    id: operationId,
    siteId: site.id,
    type: "build",
    executionTargetKey: site.executionTargetKey,
    idempotencyKey: `build:${site.id}:${version.id}`,
    inputDigest: source.inputDigest,
    inputPayload: { versionId: version.id, source, build: version.build },
    now: deps.now(),
  })
  await deps.claimOperation({
    operationId,
    leaseOwner: deps.leaseOwner,
    // An hour, matching `CloudflareSitesService.leaseMsFor`. A lease shorter
    // than the build it protects lets recovery terminate a build that is still
    // running, and the live call then fails on a lease-owner mismatch.
    leaseMs: 60 * 60 * 1000,
    now: deps.now(),
  })
  /**
   * One confined phase: announce it, run it, store what it printed, announce
   * the outcome, then throw on failure.
   *
   * The log row is written on both outcomes. A build that worked is exactly
   * what a broken one gets compared against, and until now the successful
   * path discarded its output entirely.
   */
  const runPhase = async (
    phase: Exclude<SiteBuildPhase, "package">,
    argv: string[],
    networkHosts: string[] | undefined
  ): Promise<void> => {
    await deps.appendPhaseEvent({
      operationId,
      leaseOwner: deps.leaseOwner,
      phase,
      outcome: "started",
      message: buildPhaseMessage(phase, argv),
      now: deps.now(),
    })
    const result = await deps.runBuild({
      argv,
      cwd: sourceDir,
      writableRoots: [sourceDir],
      readableRoots: [site.sourceRoot],
      env: environment.variables,
      networkHosts,
    })
    await deps.putBuildLog(
      buildLogRowFrom(result, {
        versionId: version.id,
        siteId: site.id,
        operationId,
        phase,
        argv,
        now: deps.now(),
      })
    )
    const error = failure(result, phase)
    await deps.appendPhaseEvent({
      operationId,
      leaseOwner: deps.leaseOwner,
      phase,
      outcome: error ? "failed" : "succeeded",
      message: error ? error.message : undefined,
      now: deps.now(),
    })
    if (error) throw error
  }

  try {
    if (manifest.build.install) {
      await runPhase("install", manifest.build.install, input.installNetworkHosts)
    }
    await runPhase("build", manifest.build.command, input.buildNetworkHosts)
    // `package` spawns nothing, so it produces events but no log row.
    await deps.appendPhaseEvent({
      operationId,
      leaseOwner: deps.leaseOwner,
      phase: "package",
      outcome: "started",
      message: buildPhaseMessage("package", undefined),
      now: deps.now(),
    })
    const files = await collectSiteBuildOutput(
      { sourceDir, entry: manifest.build.entry, assets: manifest.build.assets },
      deps
    )
    const artifact = await packageSiteArtifact({
      entry: manifest.build.entry,
      assets: manifest.build.assets,
      files,
    })
    await deps.appendPhaseEvent({
      operationId,
      leaseOwner: deps.leaseOwner,
      phase: "package",
      outcome: "succeeded",
      message: `${artifact.fileCount} files`,
      now: deps.now(),
    })
    await deps.putArtifact({
      digest: artifact.digest,
      bytes: artifact.bytes,
      mediaType: "application/zip",
      fileCount: artifact.fileCount,
      now: deps.now(),
    })
    const ready = await deps.completeVersion({
      versionId: version.id,
      artifactDigest: artifact.digest,
      now: deps.now(),
    })
    await deps.completeOperation({
      operationId,
      leaseOwner: deps.leaseOwner,
      now: deps.now(),
    })
    return ready
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await deps.failVersion(version.id, message, deps.now())
    await deps.failOperation({ operationId, leaseOwner: deps.leaseOwner, message, now: deps.now() })
    throw error
  }
}
