/**
 * Which Files entries a view shows, and in what order (ADR-0223). Pure; the
 * page applies it to the aggregated list.
 *
 * A view is a place (`FilesSection`) crossed with a lens (`FilesLens`), plus
 * the filter popover (format, modified, size, workspace) and the search box.
 * The Trash is its own place: it shows trashed items only and ignores the lens.
 * Every other place leaves trashed and removed ("hidden") items out.
 *
 * Workspace files (ADR-0223 §8) are many and mostly source code, so they keep
 * to their own group: All and the lenses over it never show one the person
 * has not kept. A favorited one shows under Favorites, a filed one in its
 * folder, and Recents shows those and any one opened from Files.
 */

import { entryRecency, isImageMediaType } from "./aggregate"
import { filesFormatOf, FILES_FORMATS, type FilesFormat } from "./format"
import { suggestionScore } from "./suggest"
import {
  isVideoEntry,
  type FilesEntry,
  type FilesLens,
  type FilesModifiedWithin,
  type FilesProjectScope,
  type FilesSection,
  type FilesSizeBand,
  type FilesSort,
  type FilesTypeGroup,
} from "./types"

export interface FilesFilters {
  /** Empty = every format. */
  formats: readonly FilesFormat[]
  modified: FilesModifiedWithin
  size: FilesSizeBand
  projectScope: FilesProjectScope
}

export const DEFAULT_FILES_FILTERS: FilesFilters = {
  formats: [],
  modified: "any",
  size: "any",
  projectScope: "current",
}

export interface FilesQuery {
  section: FilesSection
  lens: FilesLens
  filters: FilesFilters
  search: string
  activeProjectId?: string | null
  /** For the "modified" filter and the Suggested score. */
  now: number
  /**
   * Keys the search matched inside their content where the entries' own
   * haystack does not hold the content (a paired device's titles-only
   * entries, answered by the host). They match the search as well.
   */
  contentMatches?: ReadonlySet<string>
}

/** True when anything narrows the view beyond its place and lens. */
export function hasActiveFilters(filters: FilesFilters, search: string): boolean {
  return (
    search.trim().length > 0 ||
    filters.formats.length > 0 ||
    filters.modified !== "any" ||
    filters.size !== "any"
  )
}

/** Uploads whose bytes are an image count as images too (a duplicated image is one). */
export function isImageEntry(entry: Pick<FilesEntry, "kind" | "mediaType">): boolean {
  if (entry.kind === "image") return true
  return (
    (entry.kind === "upload" || entry.kind === "session-upload") &&
    isImageMediaType(entry.mediaType)
  )
}

export function matchesGroup(entry: FilesEntry, group: FilesTypeGroup): boolean {
  switch (group) {
    case "documents":
      return entry.kind === "canvas"
    case "artifacts":
      return entry.kind === "artifact"
    case "images":
      return isImageEntry(entry)
    case "videos":
      return isVideoEntry(entry)
    case "uploads":
      return (
        (entry.kind === "upload" || entry.kind === "session-upload") &&
        !isVideoEntry(entry) &&
        !isImageEntry(entry)
      )
    case "workspace":
      return entry.kind === "workspace-file"
  }
}

/** Same rule as ⌘K's `byProjectId`: a row with no workspace is shared, not foreign. */
export function matchesProject(
  entry: FilesEntry,
  scope: FilesProjectScope,
  activeProjectId: string | null | undefined
): boolean {
  if (scope === "all" || !activeProjectId) return true
  return entry.projectIds.length === 0 || entry.projectIds.includes(activeProjectId)
}

/** Every whitespace-separated term must appear (case-insensitive). */
export function matchesSearch(entry: FilesEntry, search: string): boolean {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean)
  return terms.every((term) => entry.searchText.includes(term))
}

const DAY_MS = 24 * 60 * 60 * 1000
const MODIFIED_WINDOW_MS: Record<Exclude<FilesModifiedWithin, "any">, number> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  year: 365 * DAY_MS,
}

/** Changed within the window (`updatedAt`; opening an item is not a change). */
export function matchesModified(
  entry: Pick<FilesEntry, "updatedAt">,
  modified: FilesModifiedWithin,
  now: number
): boolean {
  if (modified === "any") return true
  return now - entry.updatedAt <= MODIFIED_WINDOW_MS[modified]
}

const MB = 1024 * 1024

/** Bands are `[min, max)`; an entry of unknown size matches only "any". */
export function matchesSize(entry: Pick<FilesEntry, "byteSize">, size: FilesSizeBand): boolean {
  if (size === "any") return true
  const bytes = entry.byteSize
  if (bytes === undefined) return false
  switch (size) {
    case "small":
      return bytes < MB
    case "medium":
      return bytes >= MB && bytes < 10 * MB
    case "large":
      return bytes >= 10 * MB && bytes < 100 * MB
    case "huge":
      return bytes >= 100 * MB
  }
}

/**
 * Mine and AI-generated split what is the account's own by who made it;
 * Shared with me is everything that came from someone else's conversation.
 */
export function matchesLens(entry: FilesEntry, lens: FilesLens): boolean {
  switch (lens) {
    case "suggested":
      return true
    case "favorites":
      return entry.favoritedAt !== undefined
    case "mine":
      return entry.creator === "user" && !entry.sharedWithMe
    case "ai":
      return entry.creator === "ai" && !entry.sharedWithMe
    case "shared":
      return entry.sharedWithMe
  }
}

/**
 * Whether a place shows the entry. `lens` matters only for a workspace file
 * under All, which shows there through Favorites alone.
 */
export function matchesSection(
  entry: FilesEntry,
  section: FilesSection,
  lens: FilesLens = "suggested"
): boolean {
  if (section.kind === "trash") return entry.trashedAt !== undefined
  if (entry.trashedAt !== undefined || entry.hidden) return false
  switch (section.kind) {
    case "all":
      return (
        entry.kind !== "workspace-file" || (lens === "favorites" && entry.favoritedAt !== undefined)
      )
    case "recent":
      return (
        entry.kind !== "workspace-file" ||
        entry.favoritedAt !== undefined ||
        entry.folderId !== undefined ||
        entry.lastAccessedAt !== undefined
      )
    case "group":
      return matchesGroup(entry, section.group)
    case "folder":
      return entry.folderId === section.folderId
  }
}

export function filterFilesEntries(
  entries: readonly FilesEntry[],
  query: FilesQuery
): FilesEntry[] {
  const { filters } = query
  const formats = filters.formats.length > 0 ? new Set(filters.formats) : null
  return entries.filter(
    (entry) =>
      matchesSection(entry, query.section, query.lens) &&
      (query.section.kind === "trash" || matchesLens(entry, query.lens)) &&
      (formats === null || formats.has(filesFormatOf(entry))) &&
      matchesModified(entry, filters.modified, query.now) &&
      matchesSize(entry, filters.size) &&
      matchesProject(entry, filters.projectScope, query.activeProjectId) &&
      (matchesSearch(entry, query.search) || query.contentMatches?.has(entry.key) === true)
  )
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

/** Untitled images sort after named items, newest first among themselves. */
function byName(a: FilesEntry, b: FilesEntry): number {
  if (a.title && b.title) return collator.compare(a.title, b.title)
  if (a.title) return -1
  if (b.title) return 1
  return b.createdAt - a.createdAt
}

const FORMAT_ORDER = new Map(FILES_FORMATS.map((format, index) => [format, index]))

function ascending(
  key: FilesSort["key"],
  trash: boolean
): (a: FilesEntry, b: FilesEntry) => number {
  switch (key) {
    case "name":
      return byName
    case "source":
      // Items with no live conversation ("Upload", "—") sort after named sources.
      return (a, b) => {
        const left = a.originSessionTitle ?? ""
        const right = b.originSessionTitle ?? ""
        if (left && right) return collator.compare(left, right)
        return left ? -1 : right ? 1 : 0
      }
    case "activity":
      // In the Trash the date column is when an item went in.
      return trash
        ? (a, b) => (a.trashedAt ?? 0) - (b.trashedAt ?? 0)
        : (a, b) => entryRecency(a) - entryRecency(b)
    case "size":
      return (a, b) => (a.byteSize ?? -1) - (b.byteSize ?? -1)
    case "type":
      return (a, b) =>
        (FORMAT_ORDER.get(filesFormatOf(a)) ?? 0) - (FORMAT_ORDER.get(filesFormatOf(b)) ?? 0)
  }
}

/**
 * The order a view uses when no column header was clicked: the Trash by when
 * an item went in, Suggested by score, Favorites by when an item was
 * favorited, everything else (Recents included) by last activity — newest
 * first in all of them.
 */
function defaultOrder(query: Pick<FilesQuery, "section" | "lens" | "now">) {
  if (query.section.kind === "trash") {
    return (a: FilesEntry, b: FilesEntry) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0)
  }
  if (query.section.kind !== "recent" && query.lens === "suggested") {
    const scores = new Map<string, number>()
    const score = (entry: FilesEntry) => {
      let value = scores.get(entry.key)
      if (value === undefined) {
        value = suggestionScore(entry, query.now)
        scores.set(entry.key, value)
      }
      return value
    }
    return (a: FilesEntry, b: FilesEntry) => score(b) - score(a)
  }
  if (query.lens === "favorites") {
    return (a: FilesEntry, b: FilesEntry) => (b.favoritedAt ?? 0) - (a.favoritedAt ?? 0)
  }
  return (a: FilesEntry, b: FilesEntry) => entryRecency(b) - entryRecency(a)
}

/**
 * Order entries by the clicked column, or by the view's default order when
 * `sort` is null. Ties break on key so the list never reshuffles between
 * renders.
 */
export function sortFilesEntries(
  entries: readonly FilesEntry[],
  sort: FilesSort | null,
  query: Pick<FilesQuery, "section" | "lens" | "now">
): FilesEntry[] {
  const tieBreak = (a: FilesEntry, b: FilesEntry) => a.key.localeCompare(b.key)
  if (!sort) {
    const order = defaultOrder(query)
    return [...entries].sort((a, b) => order(a, b) || tieBreak(a, b))
  }
  const base = ascending(sort.key, query.section.kind === "trash")
  const sign = sort.dir === "asc" ? 1 : -1
  return [...entries].sort((a, b) => sign * base(a, b) || tieBreak(a, b))
}
