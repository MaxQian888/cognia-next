// Marketplace adapter for skills.sh ("The Agent Skills Directory").
//
// Two API surfaces:
//   - Anonymous CLI endpoints (the same ones `npx skills` uses): search,
//     snapshot download, and the add-skill.vercel.sh security audit. These
//     work with zero configuration.
//   - OIDC-protected `/api/v1` endpoints: leaderboard views (all-time /
//     trending / hot), curated collections, and detail-with-hash. Enabled
//     when the user pastes a Vercel OIDC token into Settings
//     (`AppSettings.skillsShToken`); a 401 surfaces as `SkillsShTokenError`
//     so callers can fall back to the anonymous surface.
//
// All requests route through `skillssh-http.ts` (Tauri proxy / CapacitorHttp
// / fetch) because skills.sh sends no CORS headers.

import { useSettingsStore } from "@/stores/settings"
import type { FetchSkillContent, MarketplaceItem } from "./marketplace-types"
import { SkillsHttpError, skillsHttpGetJson } from "./skillssh-http"

export const SKILLS_SH_BASE_URL = "https://skills.sh"
const AUDIT_BASE_URL = "https://add-skill.vercel.sh"

export type SkillsShLeaderboardView = "all-time" | "trending" | "hot"

export type SkillsShRisk = "safe" | "low" | "medium" | "high" | "critical" | "unknown"

export interface SkillsShAuditProvider {
  provider: string
  risk: SkillsShRisk
  score?: number
  summary?: string
}

export interface SkillsShAudit {
  providers: SkillsShAuditProvider[]
  worstRisk: SkillsShRisk
}

export interface SkillsShFile {
  path: string
  contents: string
}

export interface SkillsShDetail {
  files: SkillsShFile[]
  /** SHA-256 of the file contents — only available via `/api/v1` (token). */
  hash?: string
}

/** A `/api/v1` call was rejected — the token is missing, invalid, or expired. */
export class SkillsShTokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SkillsShTokenError"
  }
}

// ---- token + ref helpers ---------------------------------------------------

export function getSkillsShToken(): string | null {
  const settings = useSettingsStore.getState().settings
  const token = settings?.skillsShToken?.trim()
  return token || null
}

export function hasSkillsShToken(): boolean {
  return getSkillsShToken() !== null
}

export interface SkillsShRef {
  owner: string
  repo: string
  slug: string
}

/** Parse a skills.sh triple (`owner/repo/slug`) into its parts. */
export function parseSkillsShTriple(triple: string): SkillsShRef | null {
  const parts = triple.split("/").filter(Boolean)
  if (parts.length !== 3) return null
  const [owner, repo, slug] = parts
  return { owner, repo, slug }
}

function refOf(item: MarketplaceItem): SkillsShRef {
  const ref = parseSkillsShTriple(item.sourceId)
  if (!ref) {
    throw new Error(`skills.sh item "${item.name}" has a malformed id: ${item.sourceId}`)
  }
  return ref
}

// ---- wire shapes -----------------------------------------------------------

interface AnonymousSearchSkill {
  id: string
  skillId: string
  name: string
  installs?: number
  source: string
}

interface AnonymousSearchResponse {
  query?: string
  searchType?: string
  skills?: AnonymousSearchSkill[]
}

interface V1Skill {
  id: string
  slug: string
  name: string
  source: string
  installs?: number
  sourceType?: string
  installUrl?: string | null
  url?: string
  isDuplicate?: boolean
}

interface V1ListResponse {
  data?: V1Skill[]
  pagination?: { page: number; perPage: number; total: number; hasMore: boolean }
}

interface V1CuratedResponse {
  data?: Array<{
    owner: string
    totalInstalls?: number
    featuredRepo?: string
    featuredSkill?: string
    skills?: V1Skill[]
  }>
  totalOwners?: number
  totalSkills?: number
}

interface V1DetailResponse {
  id: string
  hash?: string | null
  files?: Array<{ path: string; contents: string }> | null
}

interface V1AuditResponse {
  audits?: Array<{
    provider: string
    status?: string
    summary?: string
    riskLevel?: string
  }>
}

type AnonymousAuditEntry = {
  risk?: string
  score?: number
  alerts?: number
  analyzedAt?: string
}

type AnonymousAuditResponse = Record<string, Record<string, AnonymousAuditEntry>>

// ---- mapping ---------------------------------------------------------------

function toMarketplaceItem(input: {
  triple: string
  name: string
  source: string
  installs?: number
}): MarketplaceItem {
  return {
    id: `skillssh:${input.triple}`,
    source: "skillssh",
    sourceId: input.triple,
    name: input.name,
    repository: input.source,
    downloads: input.installs,
    category: "custom",
  }
}

function fromV1(skill: V1Skill): MarketplaceItem {
  return toMarketplaceItem({
    triple: skill.id,
    name: skill.name,
    source: skill.source,
    installs: skill.installs,
  })
}

// ---- discovery -------------------------------------------------------------

export interface SkillsShQuery {
  search?: string
  limit?: number
}

/** Anonymous search. Returns [] for queries shorter than 2 characters. */
export async function fetchSkillsShItems(query: SkillsShQuery = {}): Promise<MarketplaceItem[]> {
  const q = query.search?.trim() ?? ""
  if (q.length < 2) return []
  const params = new URLSearchParams({ q, limit: String(query.limit ?? 50) })
  const data = await skillsHttpGetJson<AnonymousSearchResponse>(
    `${SKILLS_SH_BASE_URL}/api/search?${params.toString()}`
  )
  return (data.skills ?? []).map((s) =>
    toMarketplaceItem({ triple: s.id, name: s.name, source: s.source, installs: s.installs })
  )
}

async function v1Get<T>(path: string): Promise<T> {
  const token = getSkillsShToken()
  if (!token) {
    throw new SkillsShTokenError("skills.sh /api/v1 requires a Vercel OIDC token")
  }
  try {
    return await skillsHttpGetJson<T>(`${SKILLS_SH_BASE_URL}${path}`, { bearerToken: token })
  } catch (err) {
    if (err instanceof SkillsHttpError && err.status === 401) {
      throw new SkillsShTokenError("skills.sh token rejected (expired or invalid)")
    }
    throw err
  }
}

export interface SkillsShLeaderboardPage {
  items: MarketplaceItem[]
  hasMore: boolean
}

/** Token-gated leaderboard (`/api/v1/skills?view=`). */
export async function fetchSkillsShLeaderboard(
  view: SkillsShLeaderboardView,
  page = 0,
  perPage = 50
): Promise<SkillsShLeaderboardPage> {
  const params = new URLSearchParams({
    view,
    page: String(page),
    per_page: String(perPage),
  })
  const data = await v1Get<V1ListResponse>(`/api/v1/skills?${params.toString()}`)
  return {
    items: (data.data ?? []).map(fromV1),
    hasMore: data.pagination?.hasMore ?? false,
  }
}

export interface SkillsShCuratedOwner {
  owner: string
  totalInstalls: number
  items: MarketplaceItem[]
}

/** Token-gated curated collections (`/api/v1/skills/curated`). */
export async function fetchSkillsShCurated(): Promise<SkillsShCuratedOwner[]> {
  const data = await v1Get<V1CuratedResponse>("/api/v1/skills/curated")
  return (data.data ?? []).map((owner) => ({
    owner: owner.owner,
    totalInstalls: owner.totalInstalls ?? 0,
    items: (owner.skills ?? []).map(fromV1),
  }))
}

// ---- detail + files --------------------------------------------------------

/**
 * Full file set for a skill. With a token the `/api/v1` detail endpoint is
 * used (includes the server-side hash); otherwise the anonymous snapshot
 * download. A token failure falls back to the anonymous path silently —
 * detail viewing should never require configuration.
 */
export async function fetchSkillsShDetail(item: MarketplaceItem): Promise<SkillsShDetail> {
  const ref = refOf(item)
  if (hasSkillsShToken()) {
    try {
      const data = await v1Get<V1DetailResponse>(
        `/api/v1/skills/${ref.owner}/${ref.repo}/${ref.slug}`
      )
      if (data.files?.length) {
        return { files: data.files, hash: data.hash ?? undefined }
      }
    } catch (err) {
      if (!(err instanceof SkillsShTokenError)) throw err
      // fall through to the anonymous download
    }
  }
  const data = await skillsHttpGetJson<{ files?: SkillsShFile[] }>(
    `${SKILLS_SH_BASE_URL}/api/download/${ref.owner}/${ref.repo}/${ref.slug}`
  )
  if (!data.files?.length) {
    throw new Error(`skills.sh returned no files for ${item.sourceId}`)
  }
  return { files: data.files }
}

// ---- audit -----------------------------------------------------------------

const RISK_ORDER: SkillsShRisk[] = ["safe", "unknown", "low", "medium", "high", "critical"]

function normaliseRisk(value?: string): SkillsShRisk {
  const lower = value?.toLowerCase()
  switch (lower) {
    case "safe":
    case "none":
    case "pass":
      return "safe"
    case "low":
      return "low"
    case "medium":
    case "warn":
      return "medium"
    case "high":
    case "fail":
      return "high"
    case "critical":
      return "critical"
    default:
      return "unknown"
  }
}

function worstOf(providers: SkillsShAuditProvider[]): SkillsShRisk {
  let worst: SkillsShRisk = "unknown"
  for (const p of providers) {
    if (RISK_ORDER.indexOf(p.risk) > RISK_ORDER.indexOf(worst)) worst = p.risk
  }
  return providers.length > 0 ? worst : "unknown"
}

const ANONYMOUS_PROVIDER_LABELS: Record<string, string> = {
  ath: "Agent Trust Hub",
  socket: "Socket",
  snyk: "Snyk",
  zeroleaks: "ZeroLeaks",
  runlayer: "Runlayer",
}

/**
 * Security audit for a skill. Returns `null` when no partner has audited it
 * yet (404) — never throws for missing audits.
 */
export async function fetchSkillsShAudit(item: MarketplaceItem): Promise<SkillsShAudit | null> {
  const ref = refOf(item)
  try {
    if (hasSkillsShToken()) {
      try {
        const data = await v1Get<V1AuditResponse>(
          `/api/v1/skills/audit/${ref.owner}/${ref.repo}/${ref.slug}`
        )
        const providers = (data.audits ?? []).map((a) => ({
          provider: a.provider,
          risk: normaliseRisk(a.riskLevel ?? a.status),
          summary: a.summary,
        }))
        return providers.length > 0 ? { providers, worstRisk: worstOf(providers) } : null
      } catch (err) {
        if (!(err instanceof SkillsShTokenError)) throw err
        // fall through to the anonymous audit endpoint
      }
    }
    const params = new URLSearchParams({
      source: `${ref.owner}/${ref.repo}`,
      skills: ref.slug,
    })
    const data = await skillsHttpGetJson<AnonymousAuditResponse>(
      `${AUDIT_BASE_URL}/audit?${params.toString()}`
    )
    const entry = data[ref.slug]
    if (!entry) return null
    const providers = Object.entries(entry).map(([key, value]) => ({
      provider: ANONYMOUS_PROVIDER_LABELS[key] ?? key,
      risk: normaliseRisk(value?.risk),
      score: typeof value?.score === "number" ? value.score : undefined,
    }))
    return providers.length > 0 ? { providers, worstRisk: worstOf(providers) } : null
  } catch (err) {
    if (err instanceof SkillsHttpError && err.status === 404) return null
    throw err
  }
}

// ---- content (single-file install path) ------------------------------------

/**
 * SKILL.md content for the registry-compatible install path. Multi-file
 * installs should use `fetchSkillsShDetail` + `skillssh-install.ts` instead.
 */
export async function fetchSkillsShSkillContent(item: MarketplaceItem): Promise<FetchSkillContent> {
  const detail = await fetchSkillsShDetail(item)
  const skillMd = detail.files.find((f) => f.path.toLowerCase() === "skill.md")
  if (!skillMd) {
    throw new Error(`skills.sh snapshot for "${item.name}" has no SKILL.md`)
  }
  return {
    content: skillMd.contents,
    canonicalId: `skillssh:${item.sourceId}`,
    marketplaceSkillId: item.sourceId,
  }
}
