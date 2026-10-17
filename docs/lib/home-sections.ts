/**
 * The landing page's "browse by area" index, derived from the docs page tree.
 *
 * Derived rather than hand-listed: `meta.json` already says which areas exist,
 * in what order, under which group heading, with localized titles. A curated
 * copy of that list on the landing page would go stale the first time a
 * section is added or renamed, and the landing page is the one place a stale
 * link is guaranteed to be seen.
 *
 * Types are structural (not imported from `fumadocs-core`) so this stays a pure
 * module the Jest graph can load without fumadocs' ESM-only entry points.
 */

export type TreeNode =
  | { type: "page"; name: unknown; url: string }
  | { type: "separator"; name?: unknown }
  | {
      type: "folder"
      name: unknown
      index?: { type: "page"; name: unknown; url: string }
      children: TreeNode[]
    }

export interface HomeSection {
  title: string
  /** Where "open this area" lands: the folder's index page, else its first page. */
  href: string
  /** Every page in the area, nested folders included. */
  pageCount: number
  /** The first few page titles, as a preview of what the area covers. */
  preview: string[]
}

export interface HomeGroup {
  /** The `---Group---` separator above the areas; null before the first one. */
  label: string | null
  sections: HomeSection[]
}

const PREVIEW_LENGTH = 3

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function pagesOf(node: TreeNode): { name: string; url: string }[] {
  if (node.type === "page") return [{ name: text(node.name), url: node.url }]
  if (node.type === "separator") return []
  const own = node.index ? [{ name: text(node.index.name), url: node.index.url }] : []
  return [...own, ...node.children.flatMap(pagesOf)]
}

/**
 * Group the tree's top-level folders under the separator that precedes them.
 * Top-level pages (the overview, getting started) are left to the hero, and a
 * group left with no folders is dropped rather than rendered as a bare label.
 */
export function homeGroups(children: readonly TreeNode[]): HomeGroup[] {
  const groups: HomeGroup[] = []
  let current: HomeGroup = { label: null, sections: [] }

  for (const node of children) {
    if (node.type === "separator") {
      if (current.sections.length > 0) groups.push(current)
      current = { label: text(node.name) || null, sections: [] }
      continue
    }
    if (node.type !== "folder") continue

    const pages = pagesOf(node)
    const first = pages[0]
    if (!first) continue
    current.sections.push({
      title: text(node.name),
      href: node.index?.url ?? first.url,
      pageCount: pages.length,
      preview: pages
        .map((page) => page.name)
        .filter(Boolean)
        .slice(0, PREVIEW_LENGTH),
    })
  }

  if (current.sections.length > 0) groups.push(current)
  return groups
}

/** The first top-level page whose URL ends with `slug`, for the hero's links. */
export function findTopLevelPage(children: readonly TreeNode[], slug: string): string | null {
  for (const node of children) {
    if (node.type === "page" && node.url.endsWith(`/${slug}`)) return node.url
  }
  return null
}
