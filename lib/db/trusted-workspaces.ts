// Tracks which project working directories the user has explicitly trusted.
// Trust is required before we load `<cwd>/.claude/settings.json` hooks or
// custom shell commands — a malicious checkout could otherwise ship hooks
// that exfiltrate data the moment the user opens the project.
//
// Pattern mirrors VS Code's workspace trust: a single dialog on first sight,
// remembered per absolute path, revocable from settings.

import { getDb } from "./schema"

export interface TrustedWorkspace {
  /** Absolute path to the workspace root. Stored as-is from the OS. */
  path: string
  /** Wall-clock millis when the user clicked "Trust". */
  trustedAt: number
  /**
   * Optional note the user typed when granting trust ("monorepo root", etc).
   * Free-form; not validated. Surfaced in the trust-management UI.
   */
  note?: string
}

/** Whether the given absolute path has been previously trusted. */
export async function isWorkspaceTrusted(path: string): Promise<boolean> {
  if (!path) return false
  const row = await getDb().trustedWorkspaces.get(normalize(path))
  return !!row
}

/** Record the user's "Trust this workspace" decision. */
export async function trustWorkspace(path: string, note?: string): Promise<void> {
  if (!path) return
  const row: TrustedWorkspace = {
    path: normalize(path),
    trustedAt: Date.now(),
    note,
  }
  await getDb().trustedWorkspaces.put(row)
}

/** List all trusted workspaces (most recently trusted first). */
export async function listTrustedWorkspaces(): Promise<TrustedWorkspace[]> {
  return getDb().trustedWorkspaces.orderBy("trustedAt").reverse().toArray()
}

/** Revoke trust for a previously-trusted workspace. */
export async function revokeWorkspaceTrust(path: string): Promise<void> {
  if (!path) return
  await getDb().trustedWorkspaces.delete(normalize(path))
}

/**
 * Normalise a path before comparison. We don't canonicalise (would require
 * sync filesystem access); we only collapse trailing separators and uniform
 * the forward/back slash style. Two paths that point at the same directory
 * but spell differently must be trusted independently — a small UX cost
 * that's worth the implementation simplicity.
 */
function normalize(path: string): string {
  let p = path.trim()
  while (p.endsWith("/") || p.endsWith("\\")) {
    p = p.slice(0, -1)
  }
  return p
}
