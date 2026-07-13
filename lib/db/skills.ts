import type { Skill, SkillCategory, SkillSource, SkillStatus } from "@cognia/agent-config-types"
import { BUILT_IN_SKILL_CATALOG, builtinSkillId } from "@/lib/skills/built-in-catalog"
import { getDb } from "./schema"
import {
  deleteResourcesForSkill,
  listResourcesForSkill,
  replaceResourcesForSkill,
  type SkillResourceDraft,
} from "./skill-resources"

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
      | "marketplaceHash"
      | "nativeDirectory"
      | "syncOrigin"
      | "syncFingerprint"
      | "validationErrors"
      | "kind"
      | "workflowId"
    >
  > & {
    /**
     * Optional resource bundle that should land in the `skillResources`
     * table alongside the row itself. When a draft carries resources, the
     * persistence layer (`createSkill` / `upsertSkillByCanonicalId` /
     * `bulkImportSkills`) replaces the existing resource set rather than
     * appending — matching the bundle-loader's "what's in the zip is what
     * lives in Dexie" semantics. `skillId` is filled in by the persister.
     */
    resources?: Array<Omit<SkillResourceDraft, "skillId">>
  }

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
    marketplaceHash: draft.marketplaceHash,
    nativeDirectory: draft.nativeDirectory,
    syncOrigin: draft.syncOrigin ?? "frontend",
    syncFingerprint: draft.syncFingerprint,
    validationErrors: draft.validationErrors,
    kind: draft.kind,
    workflowId: draft.workflowId,
    usageCount: 0,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().skills.put(skill)
  if (draft.resources && draft.resources.length > 0) {
    await replaceResourcesForSkill(skill.id, draft.resources)
  }
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
    // Single bulkGet + bulkPut instead of a per-id get/update round-trip.
    const rows = await db.skills.bulkGet(ids)
    const updated = rows
      .filter((row): row is Skill => Boolean(row))
      .map((row) => ({ ...row, usageCount: (row.usageCount ?? 0) + 1, lastUsedAt: now }))
    if (updated.length > 0) await db.skills.bulkPut(updated)
  })
}

/** One resolved entry in the effective skill set for a send. */
export interface EffectiveSkillRef {
  id: string
  /** Where this id came from: the active character vs an ad-hoc attachment. */
  source: "character" | "ephemeral"
  /** Switched off for this session — present but will NOT be injected. */
  inert: boolean
}

/**
 * Resolve the effective skill set for a send/UI surface: the character's
 * skills followed by ad-hoc ephemeral attachments, de-duplicated (first
 * occurrence wins its source), each tagged with whether the session has it
 * disabled. This is the single source of truth shared by `build-options`
 * (send path) and the chat UI (composer chips, per-session badge) so the two
 * never drift.
 */
export function resolveEffectiveSkills(input: {
  characterSkillIds?: readonly string[]
  ephemeralSkillIds?: readonly string[]
  disabledIds?: Iterable<string>
}): EffectiveSkillRef[] {
  const disabled = new Set(input.disabledIds ?? [])
  const seen = new Set<string>()
  const out: EffectiveSkillRef[] = []
  const push = (id: string, source: EffectiveSkillRef["source"]) => {
    if (seen.has(id)) return
    seen.add(id)
    out.push({ id, source, inert: disabled.has(id) })
  }
  for (const id of input.characterSkillIds ?? []) push(id, "character")
  for (const id of input.ephemeralSkillIds ?? []) push(id, "ephemeral")
  return out
}

/** Just the ids that will actually be injected (active, de-duplicated, ordered). */
export function activeEffectiveSkillIds(input: {
  characterSkillIds?: readonly string[]
  ephemeralSkillIds?: readonly string[]
  disabledIds?: Iterable<string>
}): string[] {
  return resolveEffectiveSkills(input)
    .filter((r) => !r.inert)
    .map((r) => r.id)
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

/**
 * Idempotent upsert by `canonicalId`. The function looks up the existing
 * skill row (if any) by canonicalId and either updates it in place or
 * creates a new one. The id stays stable across re-imports, which keeps
 * `TeamCapabilityBundle.skillIds` and workflow node refs intact.
 *
 * When `draft.resources` is supplied, the resource table is rewritten via
 * `replaceResourcesForSkill` — old entries vanish, new entries land. The
 * caller (bundle import, marketplace install) decides whether to attach
 * resources at all; pure-text installs (most marketplace SKILL.md) just
 * omit the field.
 *
 * Used by `installMarketplaceItem` (marketplace) and `bulkImportSkills`
 * (bundle dialog, when the draft carries a canonicalId) so the
 * "find-by-canonicalId, replace, never duplicate" semantics live in one
 * place rather than two slightly-different copies.
 */
export async function upsertSkillByCanonicalId(input: {
  draft: SkillDraft
  canonicalId: string
  /**
   * Optional canonicalId→row map pre-loaded by a bulk caller so each draft
   * skips its own full-table scan. When supplied it is authoritative: a
   * missing key means "no existing row" (→ create). When omitted, the
   * function self-scans (single-call callers like marketplace install).
   */
  existingByCanonicalId?: Map<string, Skill>
}): Promise<{ skill: Skill; created: boolean }> {
  const { draft, canonicalId, existingByCanonicalId } = input
  const db = getDb()
  const existing = existingByCanonicalId
    ? existingByCanonicalId.get(canonicalId)
    : (await db.skills.toArray()).find((s) => s.canonicalId === canonicalId)
  if (existing) {
    await updateSkill(existing.id, {
      name: draft.name,
      description: draft.description,
      content: draft.content,
      allowedTools: draft.allowedTools,
      tags: draft.tags,
      category: draft.category ?? existing.category,
      source: draft.source ?? existing.source,
      status: draft.status ?? existing.status,
      version: draft.version ?? existing.version,
      author: draft.author ?? existing.author,
      license: draft.license ?? existing.license,
      canonicalId,
      marketplaceSkillId: draft.marketplaceSkillId ?? existing.marketplaceSkillId,
      marketplaceHash: draft.marketplaceHash ?? existing.marketplaceHash,
      nativeDirectory: draft.nativeDirectory ?? existing.nativeDirectory,
      syncOrigin: draft.syncOrigin ?? existing.syncOrigin,
      syncFingerprint: draft.syncFingerprint ?? existing.syncFingerprint,
      validationErrors: draft.validationErrors,
    })
    if (draft.resources) {
      await replaceResourcesForSkill(existing.id, draft.resources)
    }
    const refreshed = await db.skills.get(existing.id)
    return { skill: refreshed ?? existing, created: false }
  }
  const created = await createSkill({ ...draft, canonicalId })
  return { skill: created, created: true }
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
  // Reuse the single full-table load for canonicalId lookups too, so the
  // upsert path doesn't re-scan the table once per draft.
  const byCanonicalId = new Map<string, Skill>()
  for (const s of existing) if (s.canonicalId) byCanonicalId.set(s.canonicalId, s)

  for (const draft of drafts) {
    try {
      if (!draft.name?.trim()) {
        throw new Error("Skill is missing a name.")
      }
      // Drafts with a `canonicalId` (bundle import, marketplace) take the
      // idempotent upsert path so re-import of the same source keeps
      // `Skill.id` stable and never duplicates. Name-collision strategies
      // only apply to drafts without a canonicalId.
      if (draft.canonicalId) {
        const { skill, created } = await upsertSkillByCanonicalId({
          draft,
          canonicalId: draft.canonicalId,
          existingByCanonicalId: byCanonicalId,
        })
        byName.set(skill.name.toLowerCase(), skill)
        // Keep the map current so a repeated canonicalId in the same batch
        // updates the just-written row instead of creating a duplicate.
        if (skill.canonicalId) byCanonicalId.set(skill.canonicalId, skill)
        if (created) result.created += 1
        else result.updated += 1
        continue
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
        if (draft.resources) {
          await replaceResourcesForSkill(collision.id, draft.resources)
        }
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

/**
 * Render skills as a NAME-ONLY catalog (progressive disclosure) rather than
 * appending every body. Each skill becomes one `- \`id\` — name: description`
 * line under an "Available skills" heading that tells the model to call the
 * `load_skill` tool to pull a skill's full instructions when it's relevant. This
 * keeps the system prompt small even with many skills enabled — the
 * OpenCode/Anthropic "discover, then load on demand" model. Returns "" when there
 * are no skills.
 */
export function renderSkillsCatalog(skills: Skill[]): string {
  if (skills.length === 0) return ""
  const lines = skills.map((s) => {
    const desc = s.description?.trim()
    return `- \`${s.id}\` — ${s.name}${desc ? `: ${desc}` : ""}`
  })
  return [
    "## Available skills",
    "",
    "The following skills are available but their full instructions are NOT loaded. " +
      "When a skill is relevant to the current task, call the `load_skill` tool with its " +
      "id to load its instructions before you act on it. Do not guess a skill's contents.",
    "",
    ...lines,
  ].join("\n")
}

/**
 * Key-order-independent structural equality for two stored rows. Drops
 * `undefined` fields and sorts object keys recursively so the comparison
 * matches what Dexie would persist. Used to skip redundant built-in reseed
 * writes.
 */
function sameStoredRow(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm)
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, val]) => val !== undefined)
          .sort(([x], [y]) => x.localeCompare(y))
          .map(([k, val]) => [k, norm(val)])
      )
    }
    return v
  }
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b))
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
    // Functional, surface-guidance skills (authored as SKILL.md under
    // skills/built-in/, codegen'd into BUILT_IN_SKILL_CATALOG). Unlike the five
    // generic style skills above, these ship *disabled* by default: they're
    // auto-injected on the matching agent surface (see
    // lib/skills/surface-activation.ts) rather than added to every plain chat.
    // Seeding them as rows still lets users see + manually enable them in
    // Settings, and the read-merge below preserves any such user override.
    ...BUILT_IN_SKILL_CATALOG.map((entry): Skill => ({
      ...baseDefaults,
      status: "disabled" as SkillStatus,
      id: builtinSkillId(entry),
      name: entry.name,
      description: entry.description,
      content: entry.content,
      tags: entry.tags,
      category: entry.category as SkillCategory | undefined,
      allowedTools: entry.allowedTools,
      canonicalId: `builtin:${entry.id}`,
    })),
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
    const merged: Skill = {
      ...seed,
      status: existing.status ?? seed.status,
      usageCount: existing.usageCount ?? 0,
      lastUsedAt: existing.lastUsedAt,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
    }
    // Skip the write when reseeding would store a byte-identical row, so a
    // settled built-in catalog is a true no-op on every subsequent boot.
    if (sameStoredRow(merged, existing)) continue
    await db.skills.put(merged)
  }

  // Persist each functional skill's bundled reference resources into the
  // `skillResources` table so the Skills UI can browse/preview them and they
  // export with the skill. Idempotent: only rewrite when the on-disk-derived
  // set differs from what's stored, so reseeding on every boot is a no-op once
  // settled (and a built-in content update propagates on the next launch).
  for (const entry of BUILT_IN_SKILL_CATALOG) {
    if (!entry.resources || entry.resources.length === 0) continue
    const skillId = builtinSkillId(entry)
    const desired = entry.resources.map((r) => ({
      kind: r.kind,
      name: r.name,
      path: r.path,
      content: r.content,
    }))
    const existing = await listResourcesForSkill(skillId)
    const sig = (rs: Array<{ path: string; content: string }>) =>
      JSON.stringify(
        [...rs].sort((a, b) => a.path.localeCompare(b.path)).map((r) => [r.path, r.content])
      )
    if (sig(existing) !== sig(desired)) {
      await replaceResourcesForSkill(skillId, desired)
    }
  }
}
