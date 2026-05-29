// Tauri-side walker for a skill bundle laid out as a regular directory
// (`SKILL.md` + sibling `scripts/` / `references/` / `assets/` /
// `agents/openai.yaml`). The output shape matches `walk-zip.ts` so the
// downstream loader can stitch either source into the same draft.
//
// The walker reaches the filesystem through a tiny adapter (`BundleFs`)
// so tests can swap in an in-memory implementation without mocking
// `@tauri-apps/plugin-fs`. The default adapter is created lazily so the
// module stays import-safe in jsdom.

import type { SkillResourceDraft } from "@/lib/db/skill-resources"
import type { BundleArchiveReadResult } from "./walk-zip"
import { MAX_RESOURCES_PER_SKILL, MAX_RESOURCE_BYTES_WEB, validateResourcePath } from "./limits"
import { inferResourceKind, isCanonicalBundleDir } from "./classify"

export interface BundleFsEntry {
  name: string
  /** True for directories, false for files. */
  isDirectory: boolean
}

export interface BundleFs {
  /** Lists the immediate children of an absolute path. */
  readDir(path: string): Promise<BundleFsEntry[]>
  /** Reads a file as a UTF-8 string. */
  readTextFile(path: string): Promise<string>
  /** Reads a file as raw bytes. */
  readFile(path: string): Promise<Uint8Array>
  /** True if the path exists. */
  exists(path: string): Promise<boolean>
}

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdc",
  ".txt",
  ".text",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".bat",
  ".cmd",
  ".py",
  ".pyw",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".html",
  ".css",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".sql",
  ".env",
  ".gitignore",
  ".dockerignore",
  ".csv",
  ".tsv",
  ".xml",
  ".svg",
  ".lock",
  ".log",
])

function joinPath(a: string, b: string): string {
  if (!a) return b
  if (a.endsWith("/") || a.endsWith("\\")) return a + b
  return `${a}/${b}`
}

function basename(p: string): string {
  const norm = p.replace(/\\/g, "/")
  const idx = norm.lastIndexOf("/")
  return idx === -1 ? norm : norm.slice(idx + 1)
}

function encodeResource(
  relPath: string,
  bytes: Uint8Array
): { encoding: "utf-8" | "base64"; content: string } {
  const ext = (relPath.match(/\.[^./]+$/)?.[0] ?? "").toLowerCase()
  if (TEXT_EXTENSIONS.has(ext)) {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
    if (!text.includes("�")) {
      return { encoding: "utf-8", content: text }
    }
  }
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return { encoding: "base64", content: btoa(binary) }
}

/**
 * Default filesystem adapter backed by `@tauri-apps/plugin-fs`. Imported
 * lazily so this module stays jsdom-safe.
 */
async function defaultBundleFs(): Promise<BundleFs> {
  const fs = await import("@tauri-apps/plugin-fs")
  return {
    async readDir(path: string) {
      const entries = await fs.readDir(path)
      return entries.map((e) => ({
        name: e.name ?? "",
        isDirectory: !!e.isDirectory,
      }))
    },
    async readTextFile(path: string) {
      return await fs.readTextFile(path)
    },
    async readFile(path: string) {
      return await fs.readFile(path)
    },
    async exists(path: string) {
      try {
        return await fs.exists(path)
      } catch {
        return false
      }
    },
  }
}

interface RecurseAcc {
  resources: Array<Omit<SkillResourceDraft, "skillId">>
  warnings: string[]
}

/**
 * Walk the whole bundle tree, collecting every file. Kind is inferred per
 * entry via the shared classifier (canonical subdirs win, else by
 * extension) so `resources/` and other ad-hoc folders are collected rather
 * than dropped. SKILL.md and the Codex sidecar are skipped — the caller
 * reads those directly.
 */
async function recurse(
  absBase: string,
  relBase: string,
  fs: BundleFs,
  acc: RecurseAcc
): Promise<void> {
  const entries = await fs.readDir(absBase)
  for (const entry of entries) {
    const absChild = joinPath(absBase, entry.name)
    const relChild = relBase ? `${relBase}/${entry.name}` : entry.name
    if (entry.isDirectory) {
      await recurse(absChild, relChild, fs, acc)
      continue
    }
    // Skip the manifest + Codex sidecar — read separately by the caller.
    if (relChild === "SKILL.md") continue
    if (relChild === "agents/openai.yaml" || relChild === "agents/openai.yml") continue
    if (acc.resources.length >= MAX_RESOURCES_PER_SKILL) {
      acc.warnings.push(
        `Bundle has more than ${MAX_RESOURCES_PER_SKILL} resources; later entries (${relChild}…) ignored.`
      )
      return
    }
    const pathError = validateResourcePath(relChild)
    if (pathError) {
      throw new Error(`Bundle resource rejected: ${pathError}`)
    }
    const bytes = await fs.readFile(absChild)
    if (bytes.byteLength > MAX_RESOURCE_BYTES_WEB) {
      throw new Error(
        `Bundle resource ${relChild} exceeds the ${MAX_RESOURCE_BYTES_WEB} byte per-file cap.`
      )
    }
    const { encoding, content } = encodeResource(relChild, bytes)
    const kind = inferResourceKind(relChild)
    if (!isCanonicalBundleDir(relChild.split("/")[0])) {
      acc.warnings.push(
        `Resource ${relChild} lives outside scripts/ references/ assets/; classified as '${kind}'.`
      )
    }
    acc.resources.push({
      kind,
      name: basename(relChild),
      path: relChild,
      content,
      encoding,
      size: bytes.byteLength,
    })
  }
}

/**
 * Read a skill bundle laid out as a regular directory. Errors when
 * `<root>/SKILL.md` is missing. The returned shape matches `walk-zip.ts`
 * so the loader can compose either source identically.
 *
 * @param rootDir absolute path to the bundle directory
 * @param fsOverride optional filesystem adapter — defaults to Tauri's
 *                   `@tauri-apps/plugin-fs` lazily imported on first use
 */
export async function readBundleFolder(
  rootDir: string,
  fsOverride?: BundleFs
): Promise<BundleArchiveReadResult> {
  const fs = fsOverride ?? (await defaultBundleFs())

  const skillMdPath = joinPath(rootDir, "SKILL.md")
  if (!(await fs.exists(skillMdPath))) {
    throw new Error(`Bundle folder is missing SKILL.md at ${skillMdPath}.`)
  }
  const skillMd = await fs.readTextFile(skillMdPath)

  const openaiYamlPath = joinPath(joinPath(rootDir, "agents"), "openai.yaml")
  let openaiYaml: string | undefined
  if (await fs.exists(openaiYamlPath)) {
    openaiYaml = await fs.readTextFile(openaiYamlPath)
  }

  const acc: RecurseAcc = { resources: [], warnings: [] }

  // Walk the entire tree from the root. The recurse skips SKILL.md and the
  // Codex sidecar and classifies every other file via the shared
  // classifier, so canonical subdirs, Claude Code's `resources/` dir, and
  // ad-hoc folders are all collected consistently.
  await recurse(rootDir, "", fs, acc)

  return {
    skillMd,
    openaiYaml,
    resources: acc.resources,
    rootDirName: basename(rootDir),
    warnings: acc.warnings,
  }
}
