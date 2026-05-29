// Shared resource-kind classifier for the skill-bundle walkers
// (`walk-zip`, `walk-folder`). A skill bundle authored for Claude Code /
// Anthropic Agent Skills lays its extra files out under conventional
// subdirs, but the convention is loose: alongside the canonical
// `scripts/`, `references/`, `assets/` dirs, real-world bundles commonly
// ship a `resources/` dir (and other ad-hoc folders) that the walkers
// used to either drop (folder path) or lump into `asset` (zip path).
//
// This module classifies every resource consistently:
//
//   1. Files under a canonical subdir inherit that dir's kind — the
//      directory name is an explicit authoring signal and wins.
//   2. Everything else (incl. `resources/`, ad-hoc folders, root-level
//      stragglers) is classified per-file by extension so a `.py` helper
//      lands as `script`, a `.md` doc as `reference`, and a `.png` as
//      `asset`, instead of all being bucketed under one kind.

import type { SkillResourceKind } from "@/lib/claude/types"

/** Canonical Anthropic/Claude Code bundle subdirs whose name dictates kind. */
const KIND_BY_DIR: Record<string, SkillResourceKind> = {
  scripts: "script",
  references: "reference",
  assets: "asset",
}

/** Executable / runnable code — classified as `script`. */
const SCRIPT_EXTENSIONS = new Set([
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
  ".ts",
  ".tsx",
  ".jsx",
  ".rb",
  ".go",
  ".rs",
  ".pl",
  ".lua",
  ".r",
])

/** Documentation / structured text — classified as `reference`. */
const REFERENCE_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdc",
  ".txt",
  ".text",
  ".rst",
  ".adoc",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".csv",
  ".tsv",
  ".xml",
  ".html",
  ".sql",
  ".log",
])

function topSegment(relPath: string): string {
  const norm = relPath.replace(/\\/g, "/")
  const idx = norm.indexOf("/")
  return idx === -1 ? "" : norm.slice(0, idx)
}

/**
 * True when the first path segment is one of the canonical bundle subdirs
 * (`scripts/`, `references/`, `assets/`). Walkers use this to decide
 * whether to attach a "lives outside the canonical dirs" soft warning.
 */
export function isCanonicalBundleDir(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(KIND_BY_DIR, name.toLowerCase())
}

/**
 * Infer a resource kind from its bundle-relative path. Canonical subdirs
 * take precedence; anything else is classified per-file by extension,
 * falling back to `asset` for unknown/binary types.
 */
export function inferResourceKind(relPath: string): SkillResourceKind {
  const top = topSegment(relPath)
  if (top) {
    const mapped = KIND_BY_DIR[top.toLowerCase()]
    if (mapped) return mapped
  }
  const norm = relPath.replace(/\\/g, "/")
  const ext = (norm.match(/\.[^./]+$/)?.[0] ?? "").toLowerCase()
  if (SCRIPT_EXTENSIONS.has(ext)) return "script"
  if (REFERENCE_EXTENSIONS.has(ext)) return "reference"
  return "asset"
}
