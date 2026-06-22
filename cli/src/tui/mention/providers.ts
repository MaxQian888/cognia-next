/**
 * Candidate sources for the composer's `@` mention popup. Files are synchronous
 * (the directory listing is injected); skills and agents are async (disk + Dexie
 * discovery) and cached after the first load so per-keystroke filtering is cheap.
 *
 * Each source reuses existing discovery/seed code rather than reimplementing it:
 *   - files  → `completeAtPath` (`commands/file-completer.ts`)
 *   - skills → `seedDiskSkills` + `listSkills` (CLI disk import → Dexie)
 *   - agents → `discoverAgentFiles` + `buildAgents` (`agent/discover-agents.ts`)
 */
import os from "node:os"

import { listSkills as dbListSkills, upsertSkillByCanonicalId } from "@/lib/db/skills"
import type { Skill } from "@/lib/claude/types"

import { completeAtPath, type ListDir } from "../commands/file-completer"
import {
  seedDiskSkills,
  skillOriginLabel,
  type SkillScanOptions,
} from "../../skill/discover-skills"
import { ensureCliDb } from "../../db/bootstrap"
import { buildAgents, discoverAgentFiles, type AgentSummary } from "../../agent/discover-agents"
import { withBuiltinAgents } from "../../agent/builtin-agents"
import { fuzzyFilter } from "../runtime/fuzzy-filter"
import type { MentionCandidate } from "./types"

export interface MentionProviderDeps {
  cwd: string
  /** CLI home (`~/.cognia`) — skill discovery + scan dirs hang off it. */
  home: string
  /** OS home (`~`) — Claude Code / Codex skill dirs. Defaults to `os.homedir()`. */
  osHome?: string
  /** Discovery roots (project + home) for `.cognia/agents`. */
  roots: string[]
  /** Reuse external agent skill dirs. Defaults to on. */
  externalSkills?: boolean
  /** Extra skill dirs from `config.skillDirs`. */
  skillDirs?: string[]
  // ── Injectable seams (tests) ──────────────────────────────────────────────
  /** List all skills (defaults to the Dexie reader). */
  listSkills?: () => Promise<Skill[]>
  /** Import on-disk SKILL.md skills before listing (defaults to the seeder). */
  seedSkills?: () => Promise<unknown>
  /** Open the CLI-local Dexie before reads (defaults to {@link ensureCliDb}). */
  ensureDb?: () => Promise<unknown>
  /** List subagents (defaults to disk discovery). */
  listAgents?: () => Promise<AgentSummary[]>
}

export interface MentionProviders {
  /** File path candidates for the given `@` query. Synchronous. */
  files(query: string, listDir: ListDir): MentionCandidate[]
  /** Skill candidates matching `query` (case-insensitive on name/id). */
  skills(query: string): Promise<MentionCandidate[]>
  /** Agent candidates matching `query` (case-insensitive on name/id). */
  agents(query: string): Promise<MentionCandidate[]>
}

/** Build the disk-scan options from the deps — same shape the skill controller uses. */
function scanOptionsOf(deps: MentionProviderDeps): SkillScanOptions {
  return {
    cwd: deps.cwd,
    home: deps.home,
    osHome: deps.osHome ?? os.homedir(),
    customDirs: deps.skillDirs,
    external: deps.externalSkills !== false,
  }
}

/**
 * Friendly, space-free mention token for a skill. The Dexie row id is opaque for
 * built-ins (`skill_builtin_im_auto_reply`); the canonical id carries the human
 * slug after its last colon (`builtin:im-auto-reply` → `im-auto-reply`,
 * `cli-disk:project:my-skill` → `my-skill`). Falls back to the raw id when there
 * is no canonical id (legacy custom skills).
 */
export function skillMentionSlug(skill: Skill): string {
  const fromCanonical = skill.canonicalId?.split(":").pop()?.trim()
  return fromCanonical && fromCanonical.length > 0 ? fromCanonical : skill.id
}

function skillToCandidate(skill: Skill): MentionCandidate {
  const origin = skillOriginLabel(skill.canonicalId)
  const slug = skillMentionSlug(skill)
  return {
    kind: "skill",
    id: skill.id,
    label: skill.name,
    hint: skill.description,
    origin,
    slug,
    category: skill.category,
    usageCount: skill.usageCount,
    warning: (skill.validationErrors?.length ?? 0) > 0,
    insert: `@skill:${slug}`,
  }
}

function agentToCandidate(agent: AgentSummary): MentionCandidate {
  return {
    kind: "agent",
    id: agent.id,
    label: agent.name,
    hint: agent.description,
    origin: "agent",
    insert: `@agent:${agent.id}`,
  }
}

/**
 * Build the three mention providers. Skills/agents are loaded once and cached
 * for the lifetime of the returned object (i.e. the `Input` mount).
 */
export function createMentionProviders(deps: MentionProviderDeps): MentionProviders {
  const listAllSkills = deps.listSkills ?? dbListSkills
  const ensureDb = deps.ensureDb ?? (() => ensureCliDb())
  const seedSkills =
    deps.seedSkills ?? (() => seedDiskSkills(scanOptionsOf(deps), upsertSkillByCanonicalId))
  const listAllAgents =
    deps.listAgents ??
    (async () => withBuiltinAgents(buildAgents(await discoverAgentFiles(deps.roots))))

  let skillCache: MentionCandidate[] | null = null
  let agentCache: MentionCandidate[] | null = null

  async function loadSkills(): Promise<MentionCandidate[]> {
    if (skillCache) return skillCache
    try {
      await ensureDb()
      await seedSkills()
      const skills = await listAllSkills()
      skillCache = skills.map(skillToCandidate)
    } catch {
      // Discovery failed (corrupt db, unreadable dir, …) — degrade to empty so
      // the popup still shows files + agents. Don't cache the failure so a later
      // keystroke can retry.
      return []
    }
    return skillCache
  }

  async function loadAgents(): Promise<MentionCandidate[]> {
    if (agentCache) return agentCache
    try {
      const agents = await listAllAgents()
      agentCache = agents.map(agentToCandidate)
    } catch {
      return []
    }
    return agentCache
  }

  return {
    files(query, listDir) {
      // `completeAtPath` expects the full `@token`; it already filters + sorts.
      return completeAtPath(`@${query}`, listDir).map((path) => ({
        kind: "file",
        id: path,
        label: path,
        insert: path,
      }))
    },
    async skills(query) {
      const all = await loadSkills()
      // Fuzzy-rank on name / slug / description so a partial, scattered query
      // surfaces the best match first (an empty query keeps discovery order).
      return fuzzyFilter(all, query, (c) => [c.label, c.slug ?? c.id, c.hint ?? ""])
    },
    async agents(query) {
      const all = await loadAgents()
      return fuzzyFilter(all, query, (c) => [c.label, c.id, c.hint ?? ""])
    },
  }
}
