/**
 * Types for the external agent-memory manager — the `/memory` console tab that
 * surfaces and (guardedly) edits the on-disk memory / instruction files of
 * external coding agents (Claude Code, Codex).
 *
 * The discovery layer is pure and dependency-injected over {@link ExternalFs}
 * (mirrors `lib/claude/instructions/types.ts:InstructionFs`) so it is unit
 * testable without a real desktop filesystem.
 */

/** Which external agent owns a discovered file. */
export type ExternalAgentId = "claude-code" | "codex" | "opencode" | "pi"

/**
 * Where a discovered file sits in its agent's hierarchy. Drives grouping,
 * labels, and the read-only default for agent-managed scopes.
 *
 * - `user`     — Claude Code user-global `~/.claude/CLAUDE.md`
 * - `managed`  — Claude Code enterprise policy file (always read-only)
 * - `project`  — project-scoped CLAUDE.md / AGENTS.md walked root→cwd
 * - `auto`     — Claude Code auto-memory under `~/.claude/projects/<repo>/memory`
 * - `global`   — Codex global `~/.codex/AGENTS[.override].md`, OpenCode global
 *                `~/.config/opencode/AGENTS.md`
 * - `memories` — Codex-managed `~/.codex/memories/*` (always read-only)
 */
export type ExternalMemoryScope = "user" | "managed" | "project" | "auto" | "global" | "memories"

/** One discovered on-disk memory/instruction file. */
export interface ExternalMemoryFile {
  /** Stable id (the path key) — also the React list key. */
  id: string
  agent: ExternalAgentId
  scope: ExternalMemoryScope
  /** Absolute on-disk path. */
  absPath: string
  /** Display label (relative path under its owning root, else basename). */
  label: string
  /** Whether the UI may offer editing. Managed + Codex memories are never editable. */
  editable: boolean
  /** Whether the file currently exists on disk (we still surface known-but-absent slots). */
  exists: boolean
  /** File size in bytes when known. */
  bytes?: number
}

/**
 * Minimal filesystem surface the pure discovery layer needs. The real
 * implementation wraps `lib/file/file-operations.ts`; tests inject a fake.
 */
export interface ExternalFs {
  exists(path: string): Promise<boolean>
  readDir(path: string): Promise<string[]>
  stat(path: string): Promise<{ size: number; isFile: boolean }>
}

/** OS family — only the path shapes differ (managed CLAUDE.md location). */
export type ExternalPlatform = "macos" | "linux" | "windows"

/** Inputs every provider needs to enumerate its files. */
export interface DiscoverCtx {
  /** Resolved OS home directory (no trailing separator). */
  home: string
  /** Active workspace root paths, primary first (for project-scoped walks). */
  roots: string[]
  /** Current working directory inside a root (for the root→cwd walk). */
  cwd?: string
  platform: ExternalPlatform
  fs: ExternalFs
  /**
   * Environment-resolved per-vendor config roots (`lib/agent-roots/`), so
   * `$CLAUDE_CONFIG_DIR` / `$CODEX_HOME` / `$XDG_CONFIG_HOME` are honoured.
   * Optional: providers fall back to the conventional home-relative paths,
   * which keeps every existing caller and test working.
   */
  vendorRoots?: import("@/lib/agent-roots").VendorRoots
}
