/**
 * Where new workspaces get created.
 *
 * `AppSettings.projectsRoot` is a PARENT directory — "New workspace" joins it
 * with the workspace name to propose a path. It is deliberately not the same
 * field as `defaultWorkingDir`, which is the last-resort cwd a session falls
 * back to: reusing that one here would add another source of truth for "which
 * directory", which is exactly what the cwd chain is being consolidated away
 * from (see `lib/workspace/effective-cwd.ts`).
 */

import {
  detectSep,
  isDescendant,
  joinPath,
  stripTrailingSep,
} from "@/lib/claude/instructions/paths"
import { resolveHome, type ResolveHomeDeps } from "@/lib/memory/external/home"

/** Home-relative default, in the spirit of `~/IdeaProjects` and friends. */
export const DEFAULT_PROJECTS_DIR_NAME = "Projects"

/**
 * The effective parent directory for new workspaces: the configured value when
 * set, else `<home>/Projects`. Null when neither resolves — a browser or mobile
 * shell with no local filesystem, where creation happens on a paired host
 * instead and that host resolves its own root.
 */
export async function resolveProjectsRoot(
  configured: string | null | undefined,
  deps: ResolveHomeDeps = {}
): Promise<string | null> {
  const explicit = configured?.trim()
  if (explicit) return stripTrailingSep(explicit)
  const home = await resolveHome(deps)
  return home ? joinPath(home, DEFAULT_PROJECTS_DIR_NAME) : null
}

const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]", "g")

/**
 * Reduce a workspace name to ONE safe path segment.
 *
 * A name is free text, so it can carry separators, `..`, a leading `~`, or a
 * control character. The proposed path is handed to `mkdir`, so a name that
 * escapes its parent would create a directory somewhere the user never chose.
 * Everything outside a conservative allowlist collapses to `-`; leading dots go
 * too, so a name can never produce a hidden directory the user cannot find.
 */
export function sanitizeWorkspaceFolderName(name: string): string {
  const collapsed = name
    .trim()
    .replace(CONTROL_CHARS, "")
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    // Collapse the runs the substitution above creates, THEN trim the ends.
    // Order matters: trimming first leaves the next segment's leading dots
    // behind, so `../../etc` would keep a `..` in the middle of the result.
    .replace(/-{2,}/g, "-")
    .replace(/^[-.~\s]+/, "")
    .replace(/[-.\s]+$/, "")
  return collapsed || "workspace"
}

export type WorkspacePathProposal =
  | { ok: true; path: string; folderName: string }
  | { ok: false; reason: "no-parent" | "empty-name" | "escapes-parent" }

/**
 * Propose `<parent>/<sanitized name>` for a new workspace, refusing anything
 * that would land outside `parent`. The containment check runs on the JOINED
 * path rather than trusting the sanitizer, so a platform quirk in separator
 * handling cannot turn into a directory created outside the chosen parent.
 */
export function proposeWorkspacePath(
  parent: string | null | undefined,
  name: string
): WorkspacePathProposal {
  const base = parent?.trim() ? stripTrailingSep(parent.trim()) : ""
  if (!base) return { ok: false, reason: "no-parent" }
  if (!name.trim()) return { ok: false, reason: "empty-name" }

  const folderName = sanitizeWorkspaceFolderName(name)
  const sep = detectSep(base)
  if (folderName.includes(sep) || folderName.includes("/") || folderName.includes("\\")) {
    return { ok: false, reason: "escapes-parent" }
  }
  const path = joinPath(base, folderName)
  if (!isDescendant(base, path)) return { ok: false, reason: "escapes-parent" }
  return { ok: true, path, folderName }
}
