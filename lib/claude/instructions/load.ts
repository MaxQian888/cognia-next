/**
 * Tauri-backed orchestrator for project instruction loading. Composes the pure
 * discovery / import-expansion / render layers behind a small per-key memo cache
 * (because `resolveSendOptions` runs every turn and must not re-walk the tree on
 * each send). Off-Tauri (web / mobile) there is no project filesystem, so it
 * returns an empty result — mirroring `lib/lsp/project-file-reader.ts`.
 *
 * The `fs`, `isTauriEnv`, `homeDir` and `now` inputs are injectable so the whole
 * orchestration is unit-testable without a real desktop shell.
 */

import { isTauri } from "@/lib/tauri"
import { discoverInstructionPaths } from "./discover"
import { discoverMarkdownAgentFiles } from "./discover-agents"
import { expandImports } from "./imports"
import { renderInstructions } from "./render"
import { dirname, joinPath, pathKey } from "./paths"
import {
  resolveInstructionsConfig,
  type InstructionFile,
  type InstructionFs,
  type InstructionsConfig,
  type ResolvedInstructions,
} from "./types"

export interface LoadInstructionsInput {
  cwd?: string
  roots: string[]
  config?: InstructionsConfig
  /** Injected fs (tests). When omitted a real Tauri-backed adapter is built. */
  fs?: InstructionFs
  /** Override Tauri detection (tests). */
  isTauriEnv?: boolean
  /** Override the resolved home dir (tests); skips the `@tauri-apps/api/path` call. */
  homeDir?: string | null
  /** Injectable clock for the cache TTL (tests). */
  now?: () => number
}

const EMPTY: ResolvedInstructions = { section: "", files: [], markdownAgentFiles: [], warnings: [] }

const CACHE_TTL_MS = 3000
const cache = new Map<string, { at: number; value: ResolvedInstructions }>()

/** Clear the memo cache (call when settings / active workspace change). */
export function clearInstructionCache(): void {
  cache.clear()
}

/** Build the real fs adapter over `lib/file/file-operations.ts`. */
function realFs(): InstructionFs {
  return {
    async exists(path) {
      const { exists } = await import("@/lib/file/file-operations")
      return exists(path)
    },
    async readDir(path) {
      const { readDir } = await import("@/lib/file/file-operations")
      return readDir(path)
    },
    async readText(path) {
      const { readTextFile } = await import("@/lib/file/file-operations")
      return readTextFile(path)
    },
  }
}

async function resolveHome(input: LoadInstructionsInput): Promise<string | undefined> {
  if (input.homeDir !== undefined) return input.homeDir ?? undefined
  try {
    const { homeDir } = await import("@tauri-apps/api/path")
    return await homeDir()
  } catch {
    return undefined
  }
}

/** Pick the first existing `~/.cognia/<name>` global instruction file. */
async function resolveGlobalPath(
  explicit: string | undefined,
  home: string | undefined,
  fileNames: string[],
  fs: InstructionFs
): Promise<string | undefined> {
  if (explicit) return explicit
  if (!home) return undefined
  for (const name of fileNames) {
    const abs = joinPath(home, joinPath(".cognia", name))
    try {
      if (await fs.exists(abs)) return abs
    } catch {
      // ignore
    }
  }
  return undefined
}

export async function loadProjectInstructions(
  input: LoadInstructionsInput
): Promise<ResolvedInstructions> {
  const config = resolveInstructionsConfig(input.config)
  if (!config.enabled) return EMPTY

  const tauri = input.isTauriEnv ?? isTauri()
  if (!tauri && !input.fs) return EMPTY
  const fs = input.fs ?? realFs()
  const now = input.now ?? Date.now

  const key = JSON.stringify({ cwd: input.cwd ?? null, roots: input.roots, config })
  const hit = cache.get(key)
  if (hit && now() - hit.at < CACHE_TTL_MS) return hit.value

  const warnings: string[] = []
  const home = await resolveHome(input)
  const globalPath = config.includeGlobal
    ? await resolveGlobalPath(config.globalPath, home, config.fileNames, fs)
    : undefined

  const discovered = await discoverInstructionPaths({
    cwd: input.cwd,
    roots: input.roots,
    globalPath,
    config,
    fs,
  })

  const seen = new Set<string>()
  const files: InstructionFile[] = []
  for (const d of discovered) {
    const k = pathKey(d.absPath)
    if (seen.has(k)) continue // already inlined as an @import of an earlier file
    seen.add(k)
    let raw: string
    try {
      raw = await fs.readText(d.absPath)
    } catch {
      warnings.push(`could not read instruction file: ${d.label}`)
      continue
    }
    const expanded = await expandImports(raw, dirname(d.absPath), fs, {
      maxDepth: config.maxImportDepth,
      seen,
    })
    warnings.push(...expanded.warnings)
    files.push({ absPath: d.absPath, label: d.label, source: d.source, content: expanded.content })
  }

  const rendered = renderInstructions(files, config)
  warnings.push(...rendered.warnings)

  const markdownAgentFiles = config.loadProjectAgents
    ? await discoverMarkdownAgentFiles({
        roots: input.roots,
        globalAgentsDir: home ? joinPath(home, joinPath(".cognia", "agents")) : undefined,
        fs,
      })
    : []

  const value: ResolvedInstructions = {
    section: rendered.section,
    files: rendered.files,
    markdownAgentFiles,
    warnings,
  }
  cache.set(key, { at: now(), value })
  return value
}
