/**
 * Pure mapping from a git file status to its VSCode-style decoration:
 * a single letter, a Tailwind color class, and the i18n label key.
 */

import type { GitFileStatus } from "@/lib/git/types"

export interface StatusDecoration {
  letter: string
  colorClass: string
  /** Key under the `sourceControl.status` namespace. */
  labelKey: string
}

const DECORATIONS: Record<GitFileStatus, StatusDecoration> = {
  modified: { letter: "M", colorClass: "text-amber-500", labelKey: "modified" },
  added: { letter: "A", colorClass: "text-emerald-500", labelKey: "added" },
  deleted: { letter: "D", colorClass: "text-red-500", labelKey: "deleted" },
  renamed: { letter: "R", colorClass: "text-sky-500", labelKey: "renamed" },
  untracked: { letter: "U", colorClass: "text-emerald-600", labelKey: "untracked" },
  conflicted: { letter: "C", colorClass: "text-red-600", labelKey: "conflicted" },
  typeChanged: { letter: "T", colorClass: "text-violet-500", labelKey: "typeChanged" },
}

export function statusDecoration(status: GitFileStatus): StatusDecoration {
  return DECORATIONS[status]
}

/** Split a repo-relative path into `{ dir, name }` for two-tone rendering. */
export function splitPath(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf("/")
  if (idx < 0) return { dir: "", name: path }
  return { dir: path.slice(0, idx), name: path.slice(idx + 1) }
}
