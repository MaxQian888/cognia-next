// Fixture builders for Skills stories. Spread `over` to vary a single field;
// every required column gets a realistic default so the object is valid both
// for component props and for `bulkPut` into the Dexie `skills` table.
import type { Skill, SkillResource, SkillValidationError } from "@/lib/claude/types"
import type { SkillsShAudit } from "@/lib/skills/marketplace-skillssh"
import type { SkillsShFileTreeNode } from "@/lib/skills/skillssh-install"
import type { MarketplaceItem } from "@/lib/skills/marketplace-types"

let skillSeq = 0

export function makeSkill(over: Partial<Skill> = {}): Skill {
  skillSeq += 1
  const now = 1_720_000_000_000 + skillSeq * 1000
  return {
    id: `skill-${skillSeq}`,
    name: `Skill ${skillSeq}`,
    description: "Generates polished release notes from a list of merged PRs.",
    content:
      "# Release Notes\n\nSummarize the merged pull requests into customer-facing release notes.\n\n## Steps\n1. Group by area.\n2. Write one bullet per change.\n",
    allowedTools: ["read", "write"],
    tags: ["writing", "release"],
    source: "custom",
    status: "enabled",
    category: "productivity",
    version: "1.2.0",
    author: "Cognia",
    license: "MIT",
    usageCount: 12,
    lastUsedAt: now - 86_400_000,
    createdAt: now - 1_000_000,
    updatedAt: now,
    ...over,
  }
}

let resourceSeq = 0

export function makeSkillResource(over: Partial<SkillResource> = {}): SkillResource {
  resourceSeq += 1
  const now = 1_720_000_000_000 + resourceSeq * 1000
  return {
    id: `res-${resourceSeq}`,
    skillId: "skill-1",
    kind: "script",
    name: `run-${resourceSeq}.sh`,
    path: `scripts/run-${resourceSeq}.sh`,
    content: "#!/usr/bin/env bash\necho 'hello from skill resource'\n",
    encoding: "utf-8",
    mimeType: "text/x-shellscript",
    size: 48,
    inline: false,
    createdAt: now - 1000,
    updatedAt: now,
    ...over,
  }
}

export function makeValidationError(
  over: Partial<SkillValidationError> = {}
): SkillValidationError {
  return {
    code: "name-too-long",
    message: "Skill name exceeds 64 characters.",
    field: "name",
    ...over,
  }
}

export function makeAudit(over: Partial<SkillsShAudit> = {}): SkillsShAudit {
  return {
    worstRisk: "medium",
    providers: [
      { provider: "Socket", risk: "safe", score: 98, summary: "No known supply-chain issues." },
      { provider: "Snyk", risk: "medium", score: 71, summary: "One transitive advisory." },
      { provider: "ZeroLeaks", risk: "low", score: 90, summary: "No secrets detected." },
    ],
    ...over,
  }
}

let itemSeq = 0

export function makeMarketplaceItem(over: Partial<MarketplaceItem> = {}): MarketplaceItem {
  itemSeq += 1
  return {
    id: `skillssh:acme/skills/item-${itemSeq}`,
    source: "skillssh",
    sourceId: `acme/skills/item-${itemSeq}`,
    name: `Marketplace Skill ${itemSeq}`,
    description: "Drafts incident postmortems from a timeline of events.",
    author: "acme",
    category: "productivity",
    tags: ["ops", "writing"],
    repository: "acme/skills",
    license: "Apache-2.0",
    stars: 142,
    downloads: 5320,
    installed: false,
    ...over,
  }
}

export function makeFileTree(over: Partial<SkillsShFileTreeNode>[] = []): SkillsShFileTreeNode[] {
  const base: SkillsShFileTreeNode[] = [
    { path: "SKILL.md", kind: "skill", size: 1840 },
    { path: "scripts/build.sh", kind: "script", size: 320 },
    { path: "references/api.md", kind: "reference", size: 9100 },
    { path: "assets/logo.png", kind: "asset", size: 20480 },
  ]
  if (over.length === 0) return base
  return over.map((o, i) => ({ ...base[i % base.length], ...o }))
}
