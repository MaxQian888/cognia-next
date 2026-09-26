// clonedeps orchestration: clone a dependency's SOURCE repo into an ignored
// local workspace (`.cognia/clonedeps/repos/<owner__repo>/`) so agents can read
// library internals, and keep a trackable manifest (`.cognia/clonedeps.json`)
// plus a managed `.gitignore` block. Faithful to oh-my-opencode-slim's
// `docs/clonedeps.md` safety model. All side effects (git, fs, clock) are
// injectable so the suite runs hermetically.

import path from "node:path"
import fsp from "node:fs/promises"

import { runGit as defaultRunGit } from "../../../platform/process/git.ts"
import type { GitOutput } from "../../../platform/process/git.ts"
import {
  CLONEDEPS_DIR,
  MANIFEST_REL,
  REPOS_IGNORE_PATTERN,
  isHttpsRepoUrl,
  parseManifest,
  safeRepoName,
  serializeManifest,
  upsertDependency,
} from "./manifest.ts"
import type { ClonedDependency, ClonedepsManifest } from "./manifest.ts"
import { applyMarkerBlock } from "./gitignore.ts"

/** POSIX-style relative path stored in the manifest (stable across platforms). */
function manifestRelPath(safeName: string): string {
  return `.cognia/clonedeps/repos/${safeName}`
}

/** The clone's side effects; each is injectable for tests. */
export interface ClonedepsDeps {
  runGit: (args: string[], cwd: string, opts?: { timeoutMs?: number }) => Promise<GitOutput>
  fs: {
    readFile(path: string): Promise<string>
    writeFile(path: string, contents: string): Promise<unknown>
    mkdir(path: string): Promise<unknown>
    exists(path: string): Promise<boolean>
  }
  now: () => string
}

function defaultDeps(): ClonedepsDeps {
  return {
    runGit: defaultRunGit,
    fs: {
      readFile: (p) => fsp.readFile(p, "utf8"),
      writeFile: (p, c) => fsp.writeFile(p, c, "utf8"),
      mkdir: (p) => fsp.mkdir(p, { recursive: true }),
      exists: async (p) => {
        try {
          await fsp.access(p)
          return true
        } catch {
          return false
        }
      },
    },
    now: () => new Date().toISOString(),
  }
}

async function resolveRepoRoot(cwd: string, deps: ClonedepsDeps): Promise<string> {
  const { stdout } = await deps.runGit(["rev-parse", "--show-toplevel"], cwd)
  const root = stdout.trim()
  if (!root) throw new Error(`not a git repository: ${cwd}`)
  return root
}

async function readManifest(root: string, deps: ClonedepsDeps) {
  const manifestPath = path.join(root, MANIFEST_REL)
  let text = ""
  if (await deps.fs.exists(manifestPath)) {
    text = await deps.fs.readFile(manifestPath)
  }
  return { manifestPath, manifest: parseManifest(text) }
}

async function writeManifest(root: string, manifest: ClonedepsManifest, deps: ClonedepsDeps) {
  const manifestPath = path.join(root, MANIFEST_REL)
  await deps.fs.mkdir(path.dirname(manifestPath))
  await deps.fs.writeFile(manifestPath, serializeManifest(manifest))
}

async function ensureGitignore(root: string, deps: ClonedepsDeps): Promise<void> {
  const gitignorePath = path.join(root, ".gitignore")
  let existing = ""
  if (await deps.fs.exists(gitignorePath)) {
    existing = await deps.fs.readFile(gitignorePath)
  }
  const next = applyMarkerBlock(existing, [REPOS_IGNORE_PATTERN])
  if (next !== existing) await deps.fs.writeFile(gitignorePath, next)
}

/**
 * Clone one dependency source repo (idempotent — reuses an existing clone) and
 * record it in the manifest.
 */
export async function cloneDependencySource(
  args: {
    cwd: string
    repoUrl: string
    ref?: string | undefined
    name?: string | undefined
    reason?: string | undefined
    packagePath?: string | undefined
  },
  injected: Partial<ClonedepsDeps> = {}
): Promise<{
  cloned: boolean
  reused: boolean
  name: string
  path: string
  dependencyCount: number
}> {
  const deps = { ...defaultDeps(), ...injected }

  if (!args || typeof args.repoUrl !== "string") {
    throw new Error("repoUrl is required")
  }
  if (!isHttpsRepoUrl(args.repoUrl)) {
    throw new Error(
      `Only HTTPS git URLs are allowed (got "${args.repoUrl}"). SSH, plain HTTP, and local ` +
        "paths are rejected for safety."
    )
  }

  const root = await resolveRepoRoot(args.cwd, deps)
  const safeName = safeRepoName(args.repoUrl)
  const relPath = manifestRelPath(safeName)
  const absTarget = path.join(root, CLONEDEPS_DIR, "repos", safeName)

  const alreadyCloned = await deps.fs.exists(absTarget)
  if (!alreadyCloned) {
    await deps.fs.mkdir(path.dirname(absTarget))
    // --depth 1: shallow reference clone. --branch threads a tag/branch ref.
    // No lifecycle scripts ever run (omo-slim safety default) — git clone alone.
    const gitArgs = ["clone", "--depth", "1"]
    if (args.ref) gitArgs.push("--branch", args.ref)
    gitArgs.push(args.repoUrl, absTarget)
    await deps.runGit(gitArgs, root, { timeoutMs: 120_000 })
  }

  const { manifest } = await readManifest(root, deps)
  const nextManifest = upsertDependency(
    manifest,
    {
      name: args.name,
      repoUrl: args.repoUrl,
      ref: args.ref,
      path: relPath,
      packagePath: args.packagePath,
      reason: args.reason,
    },
    deps.now()
  )
  await writeManifest(root, nextManifest, deps)
  await ensureGitignore(root, deps)

  return {
    cloned: !alreadyCloned,
    reused: alreadyCloned,
    name: safeName,
    path: relPath,
    dependencyCount: nextManifest.dependencies.length,
  }
}

/** Read the clonedeps manifest for the workspace containing `cwd`. */
export async function listClonedDeps(
  args: { cwd: string },
  injected: Partial<ClonedepsDeps> = {}
): Promise<{ path: string; dependencies: ClonedDependency[] }> {
  const deps = { ...defaultDeps(), ...injected }
  const root = await resolveRepoRoot(args.cwd, deps)
  const { manifest } = await readManifest(root, deps)
  return { path: MANIFEST_REL.split(path.sep).join("/"), dependencies: manifest.dependencies }
}
