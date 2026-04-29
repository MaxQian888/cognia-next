// Common shape used by both marketplace adapters (registry + SkillsMP).
// The UI consumes this; adapters normalise their wire formats to it.

import type { SkillCategory } from "@/lib/claude/types"

export type MarketplaceSourceId = "registry" | "skillsmp"

export interface MarketplaceItem {
  /** Globally-unique id within its source — `registry:ai-elements`, `skillsmp:1234`. */
  id: string
  source: MarketplaceSourceId
  /** Source-local id (slug for registry, integer or UUID for SkillsMP). */
  sourceId: string
  name: string
  description?: string
  author?: string
  category?: SkillCategory
  tags?: string[]
  /** GitHub `owner/repo` for registry skills, full HTTPS URL for SkillsMP listings. */
  repository?: string
  /** Displayable license string. */
  license?: string
  iconUrl?: string
  /** Raw URL to the SKILL.md content. Adapters resolve this lazily. */
  rawSkillUrl?: string
  stars?: number
  downloads?: number
  /** Already-installed status, if known. */
  installed?: boolean
}

export interface FetchSkillContent {
  /** SKILL.md (frontmatter + body) as text. */
  content: string
  /** Provenance fields the install path should record. */
  canonicalId?: string
  marketplaceSkillId?: string
  rawUrl?: string
}
