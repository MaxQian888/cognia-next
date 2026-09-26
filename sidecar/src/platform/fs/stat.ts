// Shared filesystem stat helpers for built-in tools.
//
// Extracted from file-extras.mjs so the file-ops tools (and any future file
// tool) share one implementation instead of re-rolling try/catch stat logic.

import type { Stats } from "node:fs"
import fsp from "node:fs/promises"

/** `fsp.stat` of an absolute path that resolves to `null` instead of throwing on a missing path. */
export async function statOrNull(p: string): Promise<Stats | null> {
  try {
    return await fsp.stat(p)
  } catch {
    return null
  }
}

/** Stat an absolute path, throwing a clear `file not found` error when it is absent. */
export async function ensureExists(p: string): Promise<Stats> {
  const st = await statOrNull(p)
  if (!st) throw new Error(`file not found: ${p}`)
  return st
}
