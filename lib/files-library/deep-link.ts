/**
 * `/files` URLs (ADR-0223): `?section=` names the place, `?tab=` the lens and
 * `?item=` the entry whose preview opens.
 *
 * Sections serialize as `all`, `recent`, `trash`, `group:<group>` and
 * `folder:<id>`. ADR-0200 used `?tab=` for five tabs that mixed places with
 * lenses; those links still resolve — `recent`, `folders`, `images` and `all`
 * name a place, `favorites` is still a lens — and the page rewrites them to
 * the canonical form.
 */

import { ROOT_LIBRARY_FOLDER_ID } from "@/lib/db/files-library-types"

import {
  FILES_LENSES,
  FILES_TYPE_GROUPS,
  type FilesLens,
  type FilesSection,
  type FilesTypeGroup,
} from "./types"

export interface FilesLocation {
  section?: FilesSection
  lens?: FilesLens
  item?: string
}

export const DEFAULT_FILES_SECTION: FilesSection = { kind: "all" }
export const DEFAULT_FILES_LENS: FilesLens = "suggested"

export function serializeFilesSection(section: FilesSection): string {
  switch (section.kind) {
    case "all":
    case "recent":
    case "trash":
      return section.kind
    case "group":
      return `group:${section.group}`
    case "folder":
      return `folder:${section.folderId}`
  }
}

export function parseFilesSection(value: string | null | undefined): FilesSection | undefined {
  if (!value) return undefined
  if (value === "all" || value === "recent" || value === "trash") return { kind: value }
  if (value.startsWith("group:")) {
    const group = value.slice("group:".length)
    return (FILES_TYPE_GROUPS as readonly string[]).includes(group)
      ? { kind: "group", group: group as FilesTypeGroup }
      : undefined
  }
  if (value.startsWith("folder:")) {
    const folderId = value.slice("folder:".length)
    return folderId ? { kind: "folder", folderId } : undefined
  }
  return undefined
}

export function isFilesLens(value: string | null | undefined): value is FilesLens {
  return typeof value === "string" && (FILES_LENSES as readonly string[]).includes(value)
}

/** ADR-0200 `?tab=` values that named a place rather than a lens. */
const LEGACY_TAB_SECTIONS: Record<string, FilesSection> = {
  recent: { kind: "recent" },
  folders: { kind: "folder", folderId: ROOT_LIBRARY_FOLDER_ID },
  images: { kind: "group", group: "images" },
  all: { kind: "all" },
}

export interface ParsedFilesLocation {
  location: FilesLocation
  /** The URL used an ADR-0200 form; the page should replace it with `filesLocationHref`. */
  legacy: boolean
}

export function parseFilesLocation(params: {
  get: (name: string) => string | null
}): ParsedFilesLocation {
  const location: FilesLocation = {}
  let legacy = false
  const section = parseFilesSection(params.get("section"))
  if (section) location.section = section
  const tab = params.get("tab")
  if (isFilesLens(tab)) {
    location.lens = tab
  } else if (tab && LEGACY_TAB_SECTIONS[tab]) {
    location.section ??= LEGACY_TAB_SECTIONS[tab]
    legacy = true
  }
  const item = params.get("item")
  if (item) location.item = item
  return { location, legacy }
}

/** The canonical `/files` URL for a location. Defaults are left out. */
export function filesLocationHref(location: FilesLocation): string {
  const params = new URLSearchParams()
  if (location.section && serializeFilesSection(location.section) !== "all") {
    params.set("section", serializeFilesSection(location.section))
  }
  if (location.lens && location.lens !== DEFAULT_FILES_LENS) params.set("tab", location.lens)
  if (location.item) params.set("item", location.item)
  const query = params.toString()
  return query ? `/files?${query}` : "/files"
}

/** Same place? Sections are values, so `===` is not enough. */
export function sameFilesSection(a: FilesSection, b: FilesSection): boolean {
  return serializeFilesSection(a) === serializeFilesSection(b)
}
