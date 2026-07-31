/**
 * Types + config resolution for project instruction-file loading
 * (CLAUDE.md / AGENTS.md / AGENT.md) injected into the built-in agent's
 * system prompt. See ADR / the `lib/claude/instructions/` module README.
 */

import type { MarkdownAgentFile } from "@/lib/claude/agents/markdown-agents"

/** How the directory tree is walked when collecting instruction files. */
export type InstructionMode = "layered" | "nearest"

/** Where a discovered instruction file came from (used for ordering + labels). */
export type InstructionSource = "global" | "project" | "instructions-dir" | "extra" | "import"

/** User-facing config (all optional — see {@link resolveInstructionsConfig}). */
export interface InstructionsConfig {
  /** Master switch. Default `true`. */
  enabled?: boolean
  /**
   * `"layered"` (Claude Code) collects every instruction file from the project
   * root down to cwd; `"nearest"` (opencode) stops at the first ancestor dir
   * that has one. Default `"layered"`.
   */
  mode?: InstructionMode
  /** Load a global user-level instruction file. Default `true`. */
  includeGlobal?: boolean
  /** Explicit global file path. When unset and `includeGlobal`, `~/.cognia/AGENTS.md` is tried. */
  globalPath?: string
  /** Same-dir filename precedence. Default {@link DEFAULT_INSTRUCTION_FILE_NAMES}. */
  fileNames?: string[]
  /** opencode-style extra instruction paths/globs (relative to cwd or a root). */
  extraPaths?: string[]
  /** Per-file byte cap before truncation. Default 64000. */
  maxFileBytes?: number
  /** Total file cap. Default 50. */
  maxFiles?: number
  /** `@import` recursion depth. Default 5. */
  maxImportDepth?: number
  /** Discover `.cognia/agents/*.md` project subagents. Default `true`. */
  loadProjectAgents?: boolean
}

/** Fully-resolved config with every field present. */
export interface ResolvedInstructionsConfig {
  enabled: boolean
  mode: InstructionMode
  includeGlobal: boolean
  globalPath?: string
  fileNames: string[]
  extraPaths: string[]
  maxFileBytes: number
  maxFiles: number
  maxImportDepth: number
  loadProjectAgents: boolean
}

/** Default same-dir filename precedence: AGENTS.md > AGENT.md > CLAUDE.md. */
export const DEFAULT_INSTRUCTION_FILE_NAMES = ["AGENTS.md", "AGENT.md", "CLAUDE.md"]

/** Relative path of the per-project instruction directory under a workspace root. */
export const PROJECT_INSTRUCTIONS_DIR = ".cognia/instructions"

/** Relative path of the per-project markdown-subagent directory under a workspace root. */
export const PROJECT_AGENTS_DIR = ".cognia/agents"

/** A single discovered + expanded instruction file. */
export interface InstructionFile {
  /** Absolute on-disk path (dedupe key). */
  absPath: string
  /** Display label (relative path under the owning root, else basename). */
  label: string
  source: InstructionSource
  /** File body with `@import`s already expanded. */
  content: string
}

/**
 * Minimal filesystem surface the pure discovery layer needs. The real
 * implementation wraps `lib/file/file-operations.ts`; tests inject a fake.
 */
export interface InstructionFs {
  exists(path: string): Promise<boolean>
  /** Basenames within `path` (empty when the dir is absent / off-Tauri). */
  readDir(path: string): Promise<string[]>
  readText(path: string): Promise<string>
}

/** Final output handed to `resolveSendOptions`. */
export interface ResolvedInstructions {
  /** Rendered system-prompt section (empty string when nothing was found). */
  section: string
  files: InstructionFile[]
  markdownAgentFiles: MarkdownAgentFile[]
  warnings: string[]
}

export function resolveInstructionsConfig(cfg?: InstructionsConfig): ResolvedInstructionsConfig {
  const fileNames =
    cfg?.fileNames && cfg.fileNames.length > 0
      ? cfg.fileNames.map((n) => n.trim()).filter(Boolean)
      : [...DEFAULT_INSTRUCTION_FILE_NAMES]
  return {
    enabled: cfg?.enabled ?? true,
    mode: cfg?.mode === "nearest" ? "nearest" : "layered",
    includeGlobal: cfg?.includeGlobal ?? true,
    globalPath: cfg?.globalPath?.trim() || undefined,
    fileNames: fileNames.length > 0 ? fileNames : [...DEFAULT_INSTRUCTION_FILE_NAMES],
    extraPaths: (cfg?.extraPaths ?? []).map((p) => p.trim()).filter(Boolean),
    maxFileBytes: cfg?.maxFileBytes && cfg.maxFileBytes > 0 ? cfg.maxFileBytes : 64_000,
    maxFiles: cfg?.maxFiles && cfg.maxFiles > 0 ? cfg.maxFiles : 50,
    maxImportDepth:
      cfg?.maxImportDepth !== undefined && cfg.maxImportDepth >= 0 ? cfg.maxImportDepth : 5,
    loadProjectAgents: cfg?.loadProjectAgents ?? true,
  }
}
