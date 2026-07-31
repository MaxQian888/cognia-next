/**
 * Home-directory + platform resolution and Claude Code's project-path encoding.
 * Kept separate from discovery so the pure providers stay free of environment
 * lookups, and so the (DI-friendly) Tauri `homeDir()` call lives in one place
 * — mirrors `lib/chat/export-handoff-to-cli.ts`.
 */

import { stripTrailingSep } from "@/lib/claude/instructions/paths"
import type { ExternalPlatform } from "./types"

/** Resolve the OS home dir via `@tauri-apps/api/path`; null when unavailable. */
export async function defaultHomeDir(): Promise<string | null> {
  try {
    const { homeDir } = await import("@tauri-apps/api/path")
    return stripTrailingSep(await homeDir())
  } catch {
    return null
  }
}

export interface ResolveHomeDeps {
  /** Override the home resolver (tests). */
  homeDir?: () => Promise<string | null>
}

/** Resolve home (trailing separator stripped), or null when not resolvable. */
export async function resolveHome(deps: ResolveHomeDeps = {}): Promise<string | null> {
  const fn = deps.homeDir ?? defaultHomeDir
  const home = await fn()
  return home ? stripTrailingSep(home) : null
}

/**
 * Best-effort OS family detection from the navigator UA (renderer-side). Only
 * affects where the managed Claude Code CLAUDE.md lives; everything else is
 * home-relative.
 */
export function detectPlatform(ua?: string): ExternalPlatform {
  const s = (ua ?? (typeof navigator !== "undefined" ? navigator.userAgent : "")).toLowerCase()
  if (s.includes("win")) return "windows"
  if (s.includes("mac")) return "macos"
  return "linux"
}

/**
 * Claude Code encodes a project's absolute path into its auto-memory directory
 * name by replacing every `/` and `.` with `-` (e.g.
 * `/Users/x/Project/cognia-next` → `-Users-x-Project-cognia-next`). Reproduced
 * here so we can match the active workspace root against
 * `~/.claude/projects/<encoded>/memory`.
 */
export function encodeClaudeProject(absPath: string): string {
  return stripTrailingSep(absPath).replace(/[/.\\]/g, "-")
}
