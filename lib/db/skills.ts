import type { Skill, SkillCategory, SkillSource, SkillStatus } from "@/lib/claude/types"
import { getDb } from "./schema"
import { deleteResourcesForSkill } from "./skill-resources"

function newId() {
  return "skill_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export async function listSkills(): Promise<Skill[]> {
  return getDb().skills.orderBy("name").toArray()
}

export async function getSkill(id: string): Promise<Skill | undefined> {
  return getDb().skills.get(id)
}

export async function listSkillsByIds(ids: string[]): Promise<Skill[]> {
  if (ids.length === 0) return []
  const rows = await getDb().skills.bulkGet(ids)
  return rows.filter((r): r is Skill => r !== undefined)
}

export type SkillDraft = Pick<Skill, "name" | "content"> &
  Partial<
    Pick<
      Skill,
      | "description"
      | "allowedTools"
      | "tags"
      | "category"
      | "source"
      | "status"
      | "version"
      | "author"
      | "license"
      | "canonicalId"
      | "marketplaceSkillId"
      | "nativeDirectory"
      | "syncOrigin"
      | "syncFingerprint"
      | "validationErrors"
    >
  >

export async function createSkill(draft: SkillDraft): Promise<Skill> {
  const now = Date.now()
  const skill: Skill = {
    id: newId(),
    name: draft.name.trim() || "Untitled skill",
    description: draft.description,
    content: draft.content,
    allowedTools: draft.allowedTools,
    tags: draft.tags,
    category: draft.category ?? "custom",
    source: draft.source ?? "custom",
    status: draft.status ?? "enabled",
    version: draft.version,
    author: draft.author,
    license: draft.license,
    canonicalId: draft.canonicalId,
    marketplaceSkillId: draft.marketplaceSkillId,
    nativeDirectory: draft.nativeDirectory,
    syncOrigin: draft.syncOrigin ?? "frontend",
    syncFingerprint: draft.syncFingerprint,
    usageCount: 0,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().skills.put(skill)
  return skill
}

export async function updateSkill(
  id: string,
  patch: Partial<Omit<Skill, "id" | "createdAt" | "isBuiltIn">>
): Promise<void> {
  await getDb().skills.update(id, { ...patch, updatedAt: Date.now() })
}

export async function deleteSkill(id: string): Promise<void> {
  const existing = await getDb().skills.get(id)
  if (existing?.isBuiltIn) {
    throw new Error("Built-in skills cannot be deleted. Duplicate first.")
  }
  // Cascade: drop bundled resources alongside the skill row so the
  // skill_resources table doesn't accumulate orphans.
  await deleteResourcesForSkill(id)
  await getDb().skills.delete(id)
}

export async function duplicateSkill(id: string): Promise<Skill> {
  const source = await getDb().skills.get(id)
  if (!source) throw new Error(`Skill ${id} not found`)
  const now = Date.now()
  const copy: Skill = {
    ...source,
    id: newId(),
    name: `${source.name} (copy)`,
    isBuiltIn: false,
    source: "custom",
    canonicalId: undefined,
    marketplaceSkillId: undefined,
    nativeDirectory: undefined,
    syncOrigin: "frontend",
    syncFingerprint: undefined,
    lastSyncedAt: undefined,
    lastSyncError: null,
    usageCount: 0,
    lastUsedAt: undefined,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().skills.put(copy)
  return copy
}

/**
 * Toggle a skill between `enabled` and `disabled`. Built-ins can be disabled
 * (the user might find a built-in noisy) but cannot be deleted.
 */
export async function setSkillStatus(id: string, status: SkillStatus): Promise<void> {
  await getDb().skills.update(id, { status, updatedAt: Date.now() })
}

/**
 * Bump usage telemetry. Called from `lib/claude/build-options.ts` whenever a
 * skill is appended to the system prompt at send time.
 */
export async function recordSkillUsage(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const now = Date.now()
  const db = getDb()
  await db.transaction("rw", db.skills, async () => {
    for (const id of ids) {
      const row = await db.skills.get(id)
      if (!row) continue
      await db.skills.update(id, {
        usageCount: (row.usageCount ?? 0) + 1,
        lastUsedAt: now,
      })
    }
  })
}

/**
 * Return only the skills currently flagged enabled (or with no status set,
 * for back-compat). Used by `build-options` to choose what to inject into
 * the system prompt at send time.
 */
export async function listEnabledSkillsByIds(ids: string[]): Promise<Skill[]> {
  const rows = await listSkillsByIds(ids)
  return rows.filter((r) => (r.status ?? "enabled") === "enabled")
}

/** Inferred skill category — useful for normalising legacy rows on read. */
export function inferCategory(skill: Skill): SkillCategory {
  if (skill.category) return skill.category
  if (skill.isBuiltIn) return "meta"
  return "custom"
}

export function inferSource(skill: Skill): SkillSource {
  if (skill.source) return skill.source
  return skill.isBuiltIn ? "builtin" : "custom"
}

/** What to do when a draft's name collides with an existing custom skill. */
export type ImportConflictStrategy = "skip" | "duplicate" | "overwrite"

export interface BulkImportResult {
  created: number
  updated: number
  skipped: number
  errored: Array<{ name: string; error: string }>
}

/**
 * Bulk-create skills from drafts. On name collision (against any existing
 * skill, built-in or custom), behavior depends on `strategy`:
 *   - skip: leave the existing record alone; counted as `skipped`.
 *   - duplicate: create with " (imported)" suffix on the name.
 *   - overwrite: update the existing record (forbidden for built-ins; falls
 *     back to `duplicate` in that case).
 */
export async function bulkImportSkills(
  drafts: SkillDraft[],
  strategy: ImportConflictStrategy = "skip"
): Promise<BulkImportResult> {
  const db = getDb()
  const result: BulkImportResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    errored: [],
  }
  const existing = await db.skills.toArray()
  const byName = new Map(existing.map((s) => [s.name.toLowerCase(), s]))

  for (const draft of drafts) {
    try {
      if (!draft.name?.trim()) {
        throw new Error("Skill is missing a name.")
      }
      const collision = byName.get(draft.name.trim().toLowerCase())
      if (!collision) {
        const created = await createSkill(draft)
        byName.set(created.name.toLowerCase(), created)
        result.created += 1
        continue
      }
      if (strategy === "skip") {
        result.skipped += 1
        continue
      }
      if (strategy === "overwrite" && !collision.isBuiltIn) {
        await updateSkill(collision.id, {
          description: draft.description,
          content: draft.content,
          allowedTools: draft.allowedTools,
          tags: draft.tags,
          category: draft.category ?? collision.category,
          source: draft.source ?? collision.source,
          version: draft.version ?? collision.version,
          author: draft.author ?? collision.author,
          license: draft.license ?? collision.license,
        })
        result.updated += 1
        continue
      }
      // duplicate path (also overwrite-but-built-in)
      const renamed = { ...draft, name: `${draft.name} (imported)` }
      const created = await createSkill(renamed)
      byName.set(created.name.toLowerCase(), created)
      result.created += 1
    } catch (err) {
      result.errored.push({
        name: draft.name ?? "(unnamed)",
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return result
}

/**
 * Render a list of skills as a system-prompt suffix. Each skill becomes a
 * `## <name>` section followed by its markdown body, joined by blank lines.
 * Returns an empty string when there are no skills.
 */
export function renderSkillsSection(skills: Skill[]): string {
  if (skills.length === 0) return ""
  return skills.map((s) => `## ${s.name}\n\n${s.content.trim()}`).join("\n\n")
}

export async function seedBuiltInSkills(): Promise<void> {
  const db = getDb()
  const now = Date.now()
  const baseDefaults = {
    isBuiltIn: true,
    source: "builtin" as SkillSource,
    status: "enabled" as SkillStatus,
    syncOrigin: "builtin" as const,
    usageCount: 0,
    createdAt: now,
    updatedAt: now,
  }
  const builtIns: Skill[] = [
    {
      ...baseDefaults,
      id: "skill_builtin_concise",
      name: "Concise answers",
      description: "Replies are short, no preamble, no recap.",
      content:
        "Keep responses short. Skip greetings, recaps of the question, and apologies. Lead with the answer; only add explanation if the user asks for it.",
      tags: ["style"],
      category: "communication",
    },
    {
      ...baseDefaults,
      id: "skill_builtin_step_by_step",
      name: "Step-by-step reasoning",
      description: "Show numbered reasoning before the answer.",
      content:
        "Before giving the final answer, walk through your reasoning as a numbered list. Keep each step to one short sentence. Then state the answer clearly under a `### Answer` heading.",
      tags: ["reasoning"],
      category: "meta",
    },
    {
      ...baseDefaults,
      id: "skill_builtin_cite",
      name: "Cite sources",
      description: "Every factual claim cites where it came from.",
      content:
        "When you state a fact about the world, code, or the user's project, name the source: a file path with line number, a function name, a documentation URL the user shared, or 'I'm inferring this' when you have no source. Never present an inference as established fact.",
      tags: ["accuracy"],
      category: "meta",
    },
    {
      ...baseDefaults,
      id: "skill_builtin_code_review",
      name: "Code review checklist",
      description: "Reviews against correctness, clarity, security, perf.",
      content:
        "When reviewing code, work through this checklist explicitly:\n\n1. **Correctness** — does it do what it claims? Edge cases?\n2. **Clarity** — would a new contributor understand this in a year?\n3. **Security** — input validation, auth boundaries, injection surfaces.\n4. **Performance** — N+1 queries, sync work in hot paths.\n5. **Tests** — what's covered, what isn't.\n\nFor each item, either confirm \"OK\" with a short why, or describe the issue with the file path and line.",
      tags: ["engineering"],
      category: "development",
    },
    {
      ...baseDefaults,
      id: "skill_builtin_plain_english",
      name: "Plain-English explainer",
      description: "Explains technical topics without jargon.",
      content:
        "Explain technical concepts as if to a curious non-specialist. Define every acronym the first time you use it. Prefer concrete analogies to abstract definitions. If you must use a technical term, follow it with a parenthesized one-line definition.",
      tags: ["style"],
      category: "communication",
    },
  ]
  // Use `put` so newly-added defaults are applied to existing rows, but
  // never clobber user-added tags / status overrides on built-ins. Read first,
  // merge defaults, then write.
  for (const seed of builtIns) {
    const existing = await db.skills.get(seed.id)
    if (!existing) {
      await db.skills.put(seed)
      continue
    }
    // Preserve user-toggled status & usage telemetry; refresh content/category.
    await db.skills.put({
      ...seed,
      status: existing.status ?? seed.status,
      usageCount: existing.usageCount ?? 0,
      lastUsedAt: existing.lastUsedAt,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
    })
  }
}
