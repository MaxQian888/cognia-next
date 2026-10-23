/**
 * The plugin contract's share of `lib/claude/instructions/types.ts`, which re-exports these.
 */
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
