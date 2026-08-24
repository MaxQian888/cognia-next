/**
 * Directories the app is already working in that no workspace owns.
 *
 * # The two-systems problem
 *
 * Before workspaces became the attribution unit, several surfaces each kept
 * their own idea of "where work happens": the managed-worktree registry knows
 * source repositories, terminal tabs know their cwd, an execution binding knows
 * a project root. None of them created a workspace, so a machine can be busy in
 * six directories while the switcher lists one. Adoption is what collapses that
 * back to a single entity rather than leaving the two systems side by side.
 *
 * # What is offered, and what is not
 *
 * Only the *repository* is offered, never a derived checkout. A managed
 * worktree at `.cognia/worktrees/<id>` is an execution slot belonging to the
 * repo it was cut from; adopting it as a workspace would create exactly the
 * duplicate entity this is meant to remove. Providers therefore report the
 * source root, and a path already inside a known workspace is dropped by
 * `unclaimedPaths` before it can be shown.
 *
 * Dismissals are device-local by design: "do not offer me this folder" is a
 * statement about this machine's clutter, not a property of the workspace model
 * worth syncing to a phone.
 */

import { basename, pathKey } from "@/lib/claude/instructions/paths"
import type { Project } from "@/types"

import { unclaimedPaths } from "./locate-workspace"

/** Where a candidate path was observed. Ordered by how strong the signal is. */
export const ADOPTION_ORIGINS = ["worktree", "environment", "terminal", "session"] as const

export type AdoptionOrigin = (typeof ADOPTION_ORIGINS)[number]

export interface AdoptionSighting {
  path: string
  origin: AdoptionOrigin
  /** Optional detail for the row — a branch, a tab title. Not identity. */
  label?: string
}

export interface AdoptionCandidate {
  /** Normalized path, as it will be mounted. */
  path: string
  /** Proposed workspace name — the folder's own name. */
  suggestedName: string
  /** Every origin that saw this path, strongest first, de-duplicated. */
  origins: AdoptionOrigin[]
  /** How many sightings backed it. A repo seen four times is the obvious one. */
  sightings: number
}

const ORIGIN_RANK = new Map(ADOPTION_ORIGINS.map((origin, index) => [origin, index]))

/**
 * Merge sightings into the folders worth offering.
 *
 * Sorted by strongest origin, then by sighting count, then by path so the list
 * is stable across renders — a list that reshuffles while the user is reading
 * it is worse than one that is merely imperfectly ordered.
 */
export function buildAdoptionCandidates(
  sightings: readonly AdoptionSighting[],
  projects: readonly Pick<Project, "id" | "roots">[],
  dismissed: readonly string[] = []
): AdoptionCandidate[] {
  const dismissedKeys = new Set(dismissed.map((path) => pathKey(path)))

  const byKey = new Map<string, { path: string; origins: Set<AdoptionOrigin>; sightings: number }>()
  for (const sighting of sightings) {
    const path = sighting.path?.trim()
    if (!path) continue
    const key = pathKey(path)
    const entry = byKey.get(key)
    if (entry) {
      entry.origins.add(sighting.origin)
      entry.sightings += 1
    } else {
      byKey.set(key, { path, origins: new Set([sighting.origin]), sightings: 1 })
    }
  }

  // Containment is resolved once, over the merged set: a path inside a
  // workspace is not a candidate however many surfaces reported it.
  const offered = new Set(
    unclaimedPaths(
      [...byKey.values()].map((entry) => entry.path),
      projects
    ).map((path) => pathKey(path))
  )

  const out: AdoptionCandidate[] = []
  for (const [key, entry] of byKey) {
    if (!offered.has(key) || dismissedKeys.has(key)) continue
    const origins = [...entry.origins].sort(
      (a, b) => (ORIGIN_RANK.get(a) ?? 0) - (ORIGIN_RANK.get(b) ?? 0)
    )
    out.push({
      path: entry.path,
      suggestedName: basename(entry.path) || entry.path,
      origins,
      sightings: entry.sightings,
    })
  }

  return out.sort((a, b) => {
    const rank = (ORIGIN_RANK.get(a.origins[0]!) ?? 0) - (ORIGIN_RANK.get(b.origins[0]!) ?? 0)
    if (rank !== 0) return rank
    if (a.sightings !== b.sightings) return b.sightings - a.sightings
    return a.path.localeCompare(b.path)
  })
}

const DISMISSED_STORAGE_KEY = "cognia.workspace.dismissedAdoptions"

/**
 * Paths the user has told this device not to offer again.
 *
 * `localStorage` rather than `AppSettings`: the list is about one machine's
 * directories, and a phone that will never see `/Users/me/scratch` has no use
 * for a dismissal of it. Reads never throw — a corrupt value costs a suggestion
 * reappearing, which is strictly better than a surface that fails to render.
 */
export function readDismissedAdoptions(storage?: Pick<Storage, "getItem">): string[] {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage)
    const raw = store?.getItem(DISMISSED_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []
  } catch {
    return []
  }
}

/** Add one path to the device-local dismissal list. Returns the new list. */
export function dismissAdoption(
  path: string,
  storage?: Pick<Storage, "getItem" | "setItem">
): string[] {
  const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage)
  const current = readDismissedAdoptions(store ?? undefined)
  const key = pathKey(path)
  const next = current.some((entry) => pathKey(entry) === key) ? current : [...current, path]
  try {
    store?.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // A full or blocked quota costs the dismissal, not the interaction.
  }
  return next
}
