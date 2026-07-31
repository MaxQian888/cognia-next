/**
 * Pure discovery of instruction-file paths (no reading of bodies — that and
 * `@import` expansion happen in `load.ts`). Given the cwd, the workspace roots,
 * and a resolved config, produce the ordered, de-duplicated list of files to
 * inject. Order is lowest-precedence first so a later (nearer-cwd) block can
 * override an earlier one by recency:
 *
 *   global → ancestor files (root→cwd, or nearest-only) → .cognia/instructions/* → extraPaths
 */

import {
  ancestorChain,
  basename,
  dirname,
  isDescendant,
  joinPath,
  pathKey,
  relLabel,
} from "./paths"
import {
  PROJECT_INSTRUCTIONS_DIR,
  type InstructionFs,
  type InstructionSource,
  type ResolvedInstructionsConfig,
} from "./types"

export interface DiscoveredPath {
  absPath: string
  label: string
  source: InstructionSource
}

export interface DiscoverInput {
  cwd?: string
  roots: string[]
  /** Resolved global instruction file path (already home-expanded by the caller). */
  globalPath?: string
  config: ResolvedInstructionsConfig
  fs: InstructionFs
}

/** The most specific root that contains `cwd`, else undefined. */
function boundaryRoot(cwd: string | undefined, roots: string[]): string | undefined {
  if (!cwd) return undefined
  const containing = roots.filter((r) => r && isDescendant(r, cwd))
  if (containing.length === 0) return undefined
  return containing.sort((a, b) => b.length - a.length)[0]
}

/** First existing filename in a dir, honouring the configured precedence. */
async function pickInDir(
  dir: string,
  fileNames: string[],
  fs: InstructionFs
): Promise<string | undefined> {
  for (const name of fileNames) {
    const abs = joinPath(dir, name)
    try {
      if (await fs.exists(abs)) return abs
    } catch {
      // ignore unreadable candidate
    }
  }
  return undefined
}

async function listMarkdown(dir: string, fs: InstructionFs): Promise<string[]> {
  let names: string[]
  try {
    names = await fs.readDir(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => n.toLowerCase().endsWith(".md"))
    .sort()
    .map((n) => joinPath(dir, n))
}

async function resolveExtra(
  spec: string,
  cwd: string | undefined,
  roots: string[],
  fs: InstructionFs
): Promise<string[]> {
  const bases = [cwd, ...roots].filter((b): b is string => Boolean(b))
  const isAbsolute = /^([A-Za-z]:[\\/]|[\\/]|~)/.test(spec)
  // Simple trailing glob: `dir/*.md` or `*.md`.
  const globMatch = spec.match(/^(.*?)([\\/])?\*(\.[^\\/]+|)$/)
  if (globMatch && spec.includes("*")) {
    const dirSpec = globMatch[1] || "."
    const ext = (globMatch[3] || "").toLowerCase()
    const dirs = isAbsolute
      ? [dirSpec]
      : bases.map((b) => (dirSpec === "." ? b : joinPath(b, dirSpec)))
    for (const d of dirs) {
      let names: string[]
      try {
        names = await fs.readDir(d)
      } catch {
        continue
      }
      const hits = names
        .filter((n) => (ext ? n.toLowerCase().endsWith(ext) : true))
        .sort()
        .map((n) => joinPath(d, n))
      if (hits.length) return hits
    }
    return []
  }
  // Plain file: resolve against cwd then each root; first existing wins.
  const candidates = isAbsolute ? [spec] : bases.map((b) => joinPath(b, spec))
  for (const c of candidates) {
    try {
      if (await fs.exists(c)) return [c]
    } catch {
      // ignore
    }
  }
  return []
}

export async function discoverInstructionPaths(input: DiscoverInput): Promise<DiscoveredPath[]> {
  const { cwd, roots, config, fs } = input
  const out: DiscoveredPath[] = []
  const seen = new Set<string>()
  const push = (absPath: string, source: InstructionSource, root?: string) => {
    const key = pathKey(absPath)
    if (seen.has(key)) return
    seen.add(key)
    out.push({ absPath, label: relLabel(root, absPath), source })
  }

  // 1. Global user file (lowest precedence).
  if (config.includeGlobal && input.globalPath) {
    try {
      if (await fs.exists(input.globalPath)) {
        out.push({ absPath: input.globalPath, label: basename(input.globalPath), source: "global" })
        seen.add(pathKey(input.globalPath))
      }
    } catch {
      // ignore
    }
  }

  // 2. Ancestor instruction files.
  if (cwd) {
    const root = boundaryRoot(cwd, roots)
    const chain = ancestorChain(cwd, root) // nearest-first
    if (config.mode === "nearest") {
      for (const dir of chain) {
        const hit = await pickInDir(dir, config.fileNames, fs)
        if (hit) {
          push(hit, "project", root)
          break
        }
      }
    } else {
      // layered: root→cwd so the nearest dir is rendered last (highest recency).
      for (const dir of [...chain].reverse()) {
        const hit = await pickInDir(dir, config.fileNames, fs)
        if (hit) push(hit, "project", root)
      }
    }
  }

  // 3. `.cognia/instructions/*.md` under each root (primary first).
  for (const root of roots) {
    if (!root) continue
    for (const abs of await listMarkdown(joinPath(root, PROJECT_INSTRUCTIONS_DIR), fs)) {
      push(abs, "instructions-dir", root)
    }
  }

  // 4. Extra configured paths/globs (highest precedence).
  for (const spec of config.extraPaths) {
    for (const abs of await resolveExtra(spec, cwd, roots, fs)) {
      const owningRoot = roots.find((r) => r && isDescendant(r, abs))
      push(abs, "extra", owningRoot)
    }
  }

  return out
}

export { dirname }
