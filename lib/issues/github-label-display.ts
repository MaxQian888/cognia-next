/**
 * Display rows for GitHub's namespaced labels.
 *
 * `github-source.ts` emits `labelIds` as `github:<name>` so a remote label can
 * never collide with a row in the local `labels` catalogue. Nothing then wrote
 * those ids into Dexie — correctly, GitHub owns its own labels — but every
 * consumer resolved labels through `labelsById`, so `labelsById.get()` returned
 * undefined, the chip was filtered out, and the filter menu fell through to
 * `?? labelId` and showed the user the literal string `github:bug`.
 *
 * These rows are EPHEMERAL: built per render, never written to Dexie. Writing
 * them would pollute the user's own label catalogue with remote data and make
 * "rename" and "delete" mean something the tracker cannot honour against
 * GitHub.
 *
 * The colour is the deterministic `defaultLabelColor` hash, not GitHub's hex.
 * `UnifiedIssueItem` carries `labelIds` and nothing else, so recovering the
 * real hex would mean either a contract change or scanning the whole mirror
 * table on every render — neither is worth it for a swatch, and the hash is
 * stable per name so the same label keeps the same colour everywhere.
 */

import { defaultLabelColor, type LabelRow } from "@/types/labels"
import type { UnifiedIssueItem } from "@/types/issues/unified"

/** The prefix `lib/issues/sources/github-source.ts` namespaces labels with. */
export const GITHUB_LABEL_PREFIX = "github:"

export function isGithubLabelId(labelId: string): boolean {
  return labelId.startsWith(GITHUB_LABEL_PREFIX)
}

/** `github:bug` → `bug`. Returns null for anything that is not one. */
export function githubLabelName(labelId: string): string | null {
  if (!isGithubLabelId(labelId)) return null
  const name = labelId.slice(GITHUB_LABEL_PREFIX.length)
  return name.length > 0 ? name : null
}

/**
 * One display row per distinct GitHub label present on these items, sorted by
 * name so the rail's order does not depend on which issue loaded first.
 *
 * `builtin` is true so any management UI refuses to edit or delete them: they
 * are a projection of a remote catalogue, not entries the user owns.
 */
export function buildGithubLabelRows(items: readonly UnifiedIssueItem[]): LabelRow[] {
  const names = new Map<string, string>()
  for (const item of items) {
    for (const labelId of item.labelIds) {
      const name = githubLabelName(labelId)
      if (name && !names.has(labelId)) names.set(labelId, name)
    }
  }

  return [...names.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([id, name]) => ({
      id,
      scope: "issue" as const,
      name,
      color: defaultLabelColor(name),
      builtin: true,
      sortOrder: 0,
      createdAt: 0,
      updatedAt: 0,
    }))
}

/**
 * The catalogue every consumer resolves `labelIds` through: local rows first,
 * then the GitHub projections. Local wins on an id collision, which cannot
 * happen today (the prefix guarantees it) but would be the right precedence if
 * a user ever created a label literally named `github:…`.
 */
export function buildIssueLabelCatalogue(
  localLabels: readonly LabelRow[],
  items: readonly UnifiedIssueItem[]
): Map<string, LabelRow> {
  const catalogue = new Map<string, LabelRow>()
  for (const row of buildGithubLabelRows(items)) catalogue.set(row.id, row)
  for (const row of localLabels) catalogue.set(row.id, row)
  return catalogue
}
