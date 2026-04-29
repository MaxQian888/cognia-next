// Marketplace adapter for the SkillsMP API (the same backend Cognia talks
// to). Reads the base URL from app settings — when unset, the source is
// silently disabled so the Browse tab only shows the local registry.
//
// Wire format mirrors Cognia's `stores/skills/skill-marketplace-store.ts`
// normalisation so a SKILL.md downloaded here is identical to one
// downloaded by Cognia.

import { isTauri } from "@/lib/tauri"
import { skillsFetchRemoteMd } from "@/lib/claude/ipc"
import { useSettingsStore } from "@/stores/settings-store"
import type { FetchSkillContent, MarketplaceItem } from "./marketplace-types"
import type { SkillCategory } from "@/lib/claude/types"

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

interface SkillsMpListItem {
  id: string | number
  name: string
  description?: string
  author?: string
  repository?: string
  directory?: string
  stars?: number
  downloads?: number
  tags?: string[]
  category?: string
  readmeUrl?: string
  skillmdUrl?: string
  iconUrl?: string
  license?: string
}

interface SkillsMpListResponse {
  items?: SkillsMpListItem[]
  data?: SkillsMpListItem[]
  total?: number
  page?: number
  pageSize?: number
}

export interface SkillsMpQuery {
  search?: string
  category?: SkillCategory
  page?: number
  pageSize?: number
  sort?: "popular" | "recent" | "stars"
}

export function getSkillsMpBaseUrl(): string | null {
  const settings = useSettingsStore.getState().settings
  const url = settings?.skillsMpBaseUrl
  if (!url) return null
  const trimmed = url.trim().replace(/\/+$/, "")
  return trimmed || null
}

export function isSkillsMpEnabled(): boolean {
  return getSkillsMpBaseUrl() !== null
}

function normaliseCategory(s?: string): SkillCategory | undefined {
  if (!s) return undefined
  const lower = s.toLowerCase()
  return (VALID_CATEGORIES as string[]).includes(lower) ? (lower as SkillCategory) : undefined
}

function fromSkillsMp(item: SkillsMpListItem): MarketplaceItem {
  const sourceId = String(item.id)
  return {
    id: `skillsmp:${sourceId}`,
    source: "skillsmp",
    sourceId,
    name: item.name,
    description: item.description,
    author: item.author,
    category: normaliseCategory(item.category) ?? "custom",
    tags: item.tags,
    repository: item.repository,
    iconUrl: item.iconUrl,
    rawSkillUrl: item.skillmdUrl,
    stars: item.stars,
    downloads: item.downloads,
    license: item.license,
  }
}

async function httpJson<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init)
  if (!resp.ok) {
    let detail = ""
    try {
      detail = await resp.text()
    } catch {
      // ignore body read errors — surface the status alone
    }
    throw new Error(
      `${resp.status} ${resp.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ""}`
    )
  }
  return (await resp.json()) as T
}

export async function fetchSkillsMpItems(query: SkillsMpQuery = {}): Promise<MarketplaceItem[]> {
  const base = getSkillsMpBaseUrl()
  if (!base) return []
  const params = new URLSearchParams()
  if (query.search) params.set("q", query.search)
  if (query.category) params.set("category", query.category)
  if (query.page !== undefined) params.set("page", String(query.page))
  if (query.pageSize !== undefined) params.set("pageSize", String(query.pageSize))
  if (query.sort) params.set("sort", query.sort)
  const url = `${base}/skills?${params.toString()}`
  const data = await httpJson<SkillsMpListResponse>(url)
  const items = data.items ?? data.data ?? []
  return items.map(fromSkillsMp)
}

export async function fetchSkillsMpItem(id: string): Promise<MarketplaceItem | null> {
  const base = getSkillsMpBaseUrl()
  if (!base) return null
  try {
    const data = await httpJson<SkillsMpListItem>(`${base}/skills/${id}`)
    return fromSkillsMp(data)
  } catch (err) {
    console.warn("skillsmp: fetch detail failed", err)
    return null
  }
}

export async function fetchSkillsMpSkillContent(item: MarketplaceItem): Promise<FetchSkillContent> {
  if (!item.rawSkillUrl) {
    throw new Error(`SkillsMP item "${item.name}" has no skillmdUrl.`)
  }
  let content: string
  if (isTauri()) {
    content = await skillsFetchRemoteMd(item.rawSkillUrl)
  } else {
    const resp = await fetch(item.rawSkillUrl)
    if (!resp.ok) throw new Error(`fetch ${item.rawSkillUrl}: ${resp.status}`)
    content = await resp.text()
  }
  return {
    content,
    canonicalId: `skillsmp:${item.sourceId}`,
    marketplaceSkillId: item.sourceId,
    rawUrl: item.rawSkillUrl,
  }
}
