// Marketplace adapter for the project's `skills-lock.json` registry. Reads
// the lockfile via the Tauri command (desktop) and falls back to a static
// import in web mode so the Browse tab still has content. Skill content is
// fetched on demand via `skills_fetch_remote_md` (Rust) or `fetch` (web).

import { isTauri } from "@/lib/tauri"
import { skillsFetchRemoteMd, skillsLoadRegistry, type RegistrySkillEntry } from "@/lib/claude/ipc"
import type { FetchSkillContent, MarketplaceItem } from "./marketplace-types"
import type { SkillCategory } from "@/lib/claude/types"

import staticLockfile from "@/skills-lock.json"

interface LockfileShape {
  version: number
  skills: Record<
    string,
    {
      source: string
      sourceType: string
      skillPath?: string
      computedHash?: string
      displayName?: string
      description?: string
      category?: string
      tags?: string[]
      author?: string
      iconUrl?: string
      rawSkillUrl?: string
    }
  >
}

const VALID_CATEGORIES: SkillCategory[] = [
  "creative-design",
  "development",
  "enterprise",
  "productivity",
  "data-analysis",
  "communication",
  "meta",
  "custom",
]

function normaliseCategory(s?: string): SkillCategory | undefined {
  if (!s) return undefined
  const lower = s.toLowerCase()
  return (VALID_CATEGORIES as string[]).includes(lower) ? (lower as SkillCategory) : undefined
}

function fromRegistryEntry(entry: RegistrySkillEntry): MarketplaceItem {
  return {
    id: `registry:${entry.id}`,
    source: "registry",
    sourceId: entry.id,
    name: entry.displayName ?? entry.id,
    description: entry.description,
    author: entry.author,
    category: normaliseCategory(entry.category) ?? "development",
    tags: entry.tags,
    repository: entry.source,
    iconUrl: entry.iconUrl,
    rawSkillUrl: entry.rawSkillUrl ?? buildRawUrl(entry.source, entry.sourceType, entry.skillPath),
  }
}

function buildRawUrl(source: string, sourceType: string, skillPath?: string): string | undefined {
  if (sourceType !== "github" || !skillPath) return undefined
  // skillPath is `skills/<id>/SKILL.md`; treat the source as `owner/repo` and
  // assume the default branch is `main`. Users can override via `rawSkillUrl`
  // when this is wrong.
  return `https://raw.githubusercontent.com/${source}/main/${skillPath}`
}

export async function fetchRegistryItems(): Promise<MarketplaceItem[]> {
  if (isTauri()) {
    try {
      const entries = await skillsLoadRegistry()
      return entries.map(fromRegistryEntry)
    } catch (err) {
      console.warn("registry: tauri load failed, falling back to bundled", err)
    }
  }
  // Web mode (or Tauri command failed): use the bundled JSON.
  const lock = staticLockfile as LockfileShape
  const items: MarketplaceItem[] = []
  for (const [id, entry] of Object.entries(lock.skills)) {
    items.push(
      fromRegistryEntry({
        id,
        source: entry.source,
        sourceType: entry.sourceType,
        skillPath: entry.skillPath,
        computedHash: entry.computedHash,
        displayName: entry.displayName,
        description: entry.description,
        category: entry.category,
        tags: entry.tags,
        author: entry.author,
        iconUrl: entry.iconUrl,
        rawSkillUrl: entry.rawSkillUrl,
      })
    )
  }
  return items
}

export async function fetchRegistrySkillContent(item: MarketplaceItem): Promise<FetchSkillContent> {
  if (!item.rawSkillUrl) {
    throw new Error(`Registry item "${item.name}" has no rawSkillUrl.`)
  }
  let content: string
  if (isTauri()) {
    content = await skillsFetchRemoteMd(item.rawSkillUrl)
  } else {
    const resp = await fetch(item.rawSkillUrl)
    if (!resp.ok) {
      throw new Error(`fetch ${item.rawSkillUrl}: ${resp.status}`)
    }
    content = await resp.text()
  }
  return {
    content,
    canonicalId: `${item.source}:${item.sourceId}`,
    marketplaceSkillId: item.sourceId,
    rawUrl: item.rawSkillUrl,
  }
}
