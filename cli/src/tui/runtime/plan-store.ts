/**
 * Persistent plan storage — captured plans are written as markdown under
 * `~/.cognia/plans/`, mirroring OpenCode's `.opencode/plans/*.md`. This lets a
 * plan outlive the turn (and the session): `/plan` re-shows the latest, `/plan
 * list` browses saved plans, `/plan show <id>` re-opens one.
 *
 * Pure core: every fs touch is injected so this unit-tests without disk. The
 * store is best-effort — a read-only home or a corrupt file degrades to an empty
 * result rather than breaking the session.
 */
import fs from "node:fs"
import path from "node:path"

import { planIdFromFile, planTitle } from "./plan"

export interface PlanStoreDeps {
  readDir?: (dir: string) => string[]
  readFile?: (absPath: string) => string | null
  writeFile?: (absPath: string, data: string) => void
  mkdir?: (dir: string) => void
  /** Modification time (epoch ms) of a file, for newest-first ordering. */
  mtime?: (absPath: string) => number
  /** Remove a saved plan file; returns true when it was removed. */
  unlink?: (absPath: string) => boolean
}

/** A saved plan's metadata, as listed by `/plan list`. */
export interface PlanSummary {
  /** File name without `.md` — the id `/plan show <id>` takes. */
  id: string
  title: string
  /** Modification time (epoch ms); 0 when unavailable. */
  savedAt: number
}

/** Absolute path to the plans directory for a given home dir. */
export function plansDir(home: string): string {
  return path.join(home, "plans")
}

const defaultRead = (absPath: string): string | null => {
  try {
    return fs.readFileSync(absPath, "utf8")
  } catch {
    return null
  }
}

const defaultReadDir = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

const defaultWrite = (absPath: string, data: string): void => {
  fs.writeFileSync(absPath, data, "utf8")
}

const defaultMkdir = (dir: string): void => {
  fs.mkdirSync(dir, { recursive: true })
}

const defaultMtime = (absPath: string): number => {
  try {
    return fs.statSync(absPath).mtimeMs
  } catch {
    return 0
  }
}

const defaultUnlink = (absPath: string): boolean => {
  try {
    fs.unlinkSync(absPath)
    return true
  } catch {
    return false
  }
}

/**
 * Write a plan markdown file. Returns the absolute path written, or `null` when
 * the write failed (a read-only home shouldn't break the turn).
 */
export function savePlan(
  home: string,
  fileName: string,
  raw: string,
  deps: PlanStoreDeps = {}
): string | null {
  const dir = plansDir(home)
  const abs = path.join(dir, fileName)
  try {
    ;(deps.mkdir ?? defaultMkdir)(dir)
    ;(deps.writeFile ?? defaultWrite)(abs, raw)
    return abs
  } catch {
    return null
  }
}

/** List saved plans, newest first. */
export function listPlans(home: string, deps: PlanStoreDeps = {}): PlanSummary[] {
  const dir = plansDir(home)
  const read = deps.readFile ?? defaultRead
  const mtime = deps.mtime ?? defaultMtime
  const files = (deps.readDir ?? defaultReadDir)(dir).filter((f) => f.endsWith(".md"))
  const summaries = files.map((file) => {
    const abs = path.join(dir, file)
    return {
      id: planIdFromFile(file),
      title: planTitle(read(abs) ?? ""),
      savedAt: mtime(abs),
    }
  })
  // Newest first; ties (or missing mtimes) fall back to a stable reverse-name
  // sort so the most recently named plan still leads.
  return summaries.sort((a, b) => b.savedAt - a.savedAt || (a.id < b.id ? 1 : -1))
}

/** Load one saved plan's raw markdown, or `null` when absent/unreadable. */
export function loadPlan(home: string, id: string, deps: PlanStoreDeps = {}): string | null {
  const abs = path.join(plansDir(home), `${id}.md`)
  return (deps.readFile ?? defaultRead)(abs)
}

/** Delete one saved plan by id. Returns true when a file was removed (false when
 * it was absent or the unlink failed) — best-effort, never throws. */
export function deletePlan(home: string, id: string, deps: PlanStoreDeps = {}): boolean {
  const key = id.trim()
  if (!key) return false
  const abs = path.join(plansDir(home), `${key}.md`)
  return (deps.unlink ?? defaultUnlink)(abs)
}

/** The most recently saved plan (`{ id, raw }`), or `null` when none exist. */
export function latestPlan(
  home: string,
  deps: PlanStoreDeps = {}
): { id: string; raw: string } | null {
  const [newest] = listPlans(home, deps)
  if (!newest) return null
  const raw = loadPlan(home, newest.id, deps)
  if (raw == null) return null
  return { id: newest.id, raw }
}
