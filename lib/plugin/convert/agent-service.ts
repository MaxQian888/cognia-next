import {
  copyWorkspaceEntry,
  createWorkspaceDir,
  listWorkspaceDir,
  readWorkspaceFile,
  statWorkspaceFile,
  writeWorkspaceFile,
} from "@/lib/files/workspace-fs"
import type { WorkspaceEntry, WorkspaceStat } from "@/lib/files/types"
import {
  convertPluginBundle,
  detectPluginEcosystem,
  UnsupportedPluginConversionError,
  type PluginConversionReport,
  type PluginEcosystem,
} from "./ecosystem"

const MAX_SNAPSHOT_ENTRIES = 2_000
const MAX_TEXT_FILE_BYTES = 1_000_000
const PLAN_TTL_MS = 15 * 60 * 1_000
const TEXT_FILE_PATTERN =
  /\.(?:md|markdown|txt|json|jsonc|toml|ya?ml|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|py|rs|css|html)$/i

export interface PluginConversionWorkspaceFs {
  listDir(root: string, relPath: string): Promise<WorkspaceEntry[]>
  stat(root: string, relPath: string): Promise<WorkspaceStat>
  readText(root: string, relPath: string, maxBytes?: number): Promise<string>
  createDir(root: string, relPath: string): Promise<void>
  writeText(root: string, relPath: string, content: string): Promise<void>
  copy(root: string, fromRelPath: string, toRelPath: string): Promise<void>
}

export interface InspectPluginConversionInput {
  workspaceRoot: string
  sourceDir: string
  target: PluginEcosystem
}

export interface InspectPluginConversionResult {
  applicable: boolean
  planId?: string
  sourceFormat: PluginEcosystem
  target: PluginEcosystem
  pluginId?: string
  proposedOutputDir: string
  files: string[]
  report: PluginConversionReport
  expiresAt?: number
}

export interface ApplyPluginConversionInput {
  workspaceRoot: string
  planId: string
  outputDir: string
}

export interface ApplyPluginConversionResult {
  pluginId: string
  sourceFormat: PluginEcosystem
  target: PluginEcosystem
  outputDir: string
  files: string[]
  warnings: PluginConversionReport["warnings"]
}

interface Snapshot {
  files: Map<string, string>
  binaryPaths: Set<string>
  fingerprintInput: string
}

interface ConversionPlan {
  workspaceRoot: string
  sourceDir: string
  target: PluginEcosystem
  digest: string
  expiresAt: number
}

export interface PluginConversionServiceOptions {
  fs?: PluginConversionWorkspaceFs
  createPlanId?: () => string
  digest?: (value: string) => Promise<string>
  now?: () => number
}

export interface PluginConversionService {
  inspect(input: InspectPluginConversionInput): Promise<InspectPluginConversionResult>
  apply(input: ApplyPluginConversionInput): Promise<ApplyPluginConversionResult>
}

async function listAllWorkspaceEntries(root: string, relPath: string): Promise<WorkspaceEntry[]> {
  return listWorkspaceDir(root, relPath, true)
}

const workspaceFs: PluginConversionWorkspaceFs = {
  // Plugin bundles may intentionally commit ignored build artifacts such as
  // dist/index.js; conversion must snapshot the complete source directory.
  listDir: listAllWorkspaceEntries,
  stat: statWorkspaceFile,
  readText: readWorkspaceFile,
  createDir: createWorkspaceDir,
  writeText: writeWorkspaceFile,
  copy: copyWorkspaceEntry,
}

function normalizeRelativeDirectory(value: string, field: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/\/+/g, "/").replace(/\/$/, "")
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    throw new Error(`${field} must stay inside the active workspace`)
  }
  if (!normalized || normalized === ".") {
    throw new Error(`${field} must name a directory inside the active workspace`)
  }
  return normalized.replace(/^\.\//, "")
}

function joinRelative(base: string, relative: string): string {
  return `${base}/${relative}`
}

function parentDirectory(path: string): string {
  return path.slice(0, path.lastIndexOf("/"))
}

function defaultOutputDir(sourceDir: string, target: PluginEcosystem): string {
  return `${sourceDir}-${target}`
}

function isSameOrDescendant(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`)
}

async function defaultDigest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function defaultCreatePlanId(): string {
  return globalThis.crypto.randomUUID()
}

async function collectSnapshot(
  fs: PluginConversionWorkspaceFs,
  workspaceRoot: string,
  sourceDir: string
): Promise<Snapshot> {
  const sourceStat = await fs.stat(workspaceRoot, sourceDir)
  if (!sourceStat.exists) throw new Error(`plugin source directory does not exist: ${sourceDir}`)
  if (!sourceStat.isDir) throw new Error(`plugin source must be a directory: ${sourceDir}`)

  const queue = [sourceDir]
  const entries: WorkspaceEntry[] = []
  while (queue.length > 0) {
    const directory = queue.shift() as string
    const children = await fs.listDir(workspaceRoot, directory)
    for (const child of children) {
      entries.push(child)
      if (entries.length > MAX_SNAPSHOT_ENTRIES) {
        throw new Error(
          `plugin source contains more than ${MAX_SNAPSHOT_ENTRIES} entries; choose a narrower sourceDir`
        )
      }
      if (child.isDir) queue.push(child.relPath)
    }
  }

  const files = new Map<string, string>()
  const binaryPaths = new Set<string>()
  const fingerprint: string[] = []
  const sourcePrefix = `${sourceDir}/`
  for (const entry of entries
    .filter((candidate) => !candidate.isDir)
    .sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    if (!entry.relPath.startsWith(sourcePrefix)) {
      throw new Error(`workspace returned a path outside sourceDir: ${entry.relPath}`)
    }
    const relative = entry.relPath.slice(sourcePrefix.length)
    if (!TEXT_FILE_PATTERN.test(relative)) {
      files.set(relative, "")
      binaryPaths.add(relative)
      fingerprint.push(`binary\0${relative}\0${entry.size}\0${entry.mtimeMs ?? ""}`)
      continue
    }
    if (entry.size > MAX_TEXT_FILE_BYTES) {
      throw new Error(`plugin text file is too large to convert safely: ${relative}`)
    }
    const content = await fs.readText(workspaceRoot, entry.relPath, MAX_TEXT_FILE_BYTES)
    files.set(relative, content)
    fingerprint.push(`text\0${relative}\0${content}`)
  }
  return { files, binaryPaths, fingerprintInput: fingerprint.join("\u0001") }
}

async function assertWritableOutput(
  fs: PluginConversionWorkspaceFs,
  workspaceRoot: string,
  outputDir: string
): Promise<void> {
  const stat = await fs.stat(workspaceRoot, outputDir)
  if (!stat.exists) return
  if (!stat.isDir) throw new Error(`output path exists and is not a directory: ${outputDir}`)
  if ((await fs.listDir(workspaceRoot, outputDir)).length > 0) {
    throw new Error(`output directory is not empty: ${outputDir}`)
  }
}

export function createPluginConversionService(
  options: PluginConversionServiceOptions = {}
): PluginConversionService {
  const fs = options.fs ?? workspaceFs
  const createPlanId = options.createPlanId ?? defaultCreatePlanId
  const digest = options.digest ?? defaultDigest
  const now = options.now ?? Date.now
  const plans = new Map<string, ConversionPlan>()

  return {
    async inspect(input) {
      const workspaceRoot = input.workspaceRoot.trim()
      if (!workspaceRoot) throw new Error("an active workspace is required")
      const sourceDir = normalizeRelativeDirectory(input.sourceDir, "sourceDir")
      const snapshot = await collectSnapshot(fs, workspaceRoot, sourceDir)
      const sourceFormat = detectPluginEcosystem(snapshot.files)
      const proposedOutputDir = defaultOutputDir(sourceDir, input.target)

      try {
        const conversion = convertPluginBundle(snapshot.files, input.target, {
          binaryPaths: snapshot.binaryPaths,
        })
        const planId = createPlanId()
        const expiresAt = now() + PLAN_TTL_MS
        plans.set(planId, {
          workspaceRoot,
          sourceDir,
          target: input.target,
          digest: await digest(snapshot.fingerprintInput),
          expiresAt,
        })
        return {
          applicable: true,
          planId,
          sourceFormat,
          target: input.target,
          pluginId: conversion.manifest.id,
          proposedOutputDir,
          files: Array.from(conversion.files.keys()).sort(),
          report: conversion.report,
          expiresAt,
        }
      } catch (error) {
        if (!(error instanceof UnsupportedPluginConversionError)) throw error
        return {
          applicable: false,
          sourceFormat,
          target: input.target,
          proposedOutputDir,
          files: [],
          report: error.report,
        }
      }
    },

    async apply(input) {
      const workspaceRoot = input.workspaceRoot.trim()
      const plan = plans.get(input.planId)
      if (!plan) throw new Error("unknown or already applied conversion plan; inspect again")
      if (plan.workspaceRoot !== workspaceRoot) {
        throw new Error("conversion plan belongs to a different workspace; inspect again")
      }
      if (now() > plan.expiresAt) {
        plans.delete(input.planId)
        throw new Error("conversion plan expired; inspect again")
      }

      const outputDir = normalizeRelativeDirectory(input.outputDir, "outputDir")
      if (
        isSameOrDescendant(plan.sourceDir, outputDir) ||
        isSameOrDescendant(outputDir, plan.sourceDir)
      ) {
        throw new Error("sourceDir and outputDir must not overlap")
      }
      await assertWritableOutput(fs, workspaceRoot, outputDir)

      const snapshot = await collectSnapshot(fs, workspaceRoot, plan.sourceDir)
      if ((await digest(snapshot.fingerprintInput)) !== plan.digest) {
        plans.delete(input.planId)
        throw new Error("plugin source changed after inspection; inspect again")
      }
      const conversion = convertPluginBundle(snapshot.files, plan.target, {
        binaryPaths: snapshot.binaryPaths,
      })

      const writes = new Map<string, string>()
      const copies = new Map<string, { from: string; to: string }>()
      for (const [relative, content] of conversion.files) {
        if (snapshot.binaryPaths.has(relative) && content === "") {
          copies.set(`${relative}\0${relative}`, { from: relative, to: relative })
        } else {
          writes.set(relative, content)
        }
      }
      for (const copy of conversion.copies) {
        copies.set(`${copy.from}\0${copy.to}`, copy)
      }

      await fs.createDir(workspaceRoot, outputDir)
      const written: string[] = []
      for (const [relative, content] of Array.from(writes).sort(([a], [b]) => a.localeCompare(b))) {
        const target = joinRelative(outputDir, relative)
        await fs.createDir(workspaceRoot, parentDirectory(target))
        await fs.writeText(workspaceRoot, target, content)
        written.push(relative)
      }
      for (const copy of Array.from(copies.values()).sort((a, b) => a.to.localeCompare(b.to))) {
        const target = joinRelative(outputDir, copy.to)
        await fs.createDir(workspaceRoot, parentDirectory(target))
        await fs.copy(workspaceRoot, joinRelative(plan.sourceDir, copy.from), target)
        written.push(copy.to)
      }

      plans.delete(input.planId)
      return {
        pluginId: conversion.manifest.id,
        sourceFormat: conversion.source,
        target: conversion.target,
        outputDir,
        files: Array.from(new Set(written)).sort(),
        warnings: conversion.report.warnings,
      }
    },
  }
}

let sharedService: PluginConversionService | undefined

export function getPluginConversionService(): PluginConversionService {
  sharedService ??= createPluginConversionService()
  return sharedService
}
