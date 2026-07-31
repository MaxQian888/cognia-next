// Shared filesystem stat helpers for built-in tools.
//
// Extracted from file-extras.mjs so the file-ops tools (and any future file
// tool) share one implementation instead of re-rolling try/catch stat logic.

import fsp from "node:fs/promises"

/**
 * `fsp.stat` that resolves to `null` instead of throwing on a missing path.
 *
 * @param {string} p Absolute path.
 * @returns {Promise<import("node:fs").Stats | null>}
 */
export async function statOrNull(p) {
  try {
    return await fsp.stat(p)
  } catch {
    return null
  }
}

/**
 * Stat a path, throwing a clear `file not found` error when it is absent.
 *
 * @param {string} p Absolute path.
 * @returns {Promise<import("node:fs").Stats>}
 */
export async function ensureExists(p) {
  const st = await statOrNull(p)
  if (!st) throw new Error(`file not found: ${p}`)
  return st
}
