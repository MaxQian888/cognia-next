// Bidirectional sync between Dexie skills and ~/.claude/skills/<dir>/. The
// frontend is the SoT, but the on-disk view is what other Claude tooling
// reads, so users can opt in to "push to disk" or "pull from disk" via the
// toolbar Sync button.
//
// Identity: skills are matched by `nativeDirectory` first, then by name slug.
// We never delete on-disk skills the user didn't originate from the app —
// only ones whose `nativeDirectory` we recorded.

import {
  skillsInstallNative,
  skillsScanNative,
  type InstallSkillRequest,
  type NativeSkill,
  type NativeSkillResource,
} from "@/lib/claude/ipc"
import { bulkImportSkills, listSkills, updateSkill } from "@/lib/db/skills"
import {
  listResourcesForSkill,
  replaceResourcesForSkill,
  type SkillResourceDraft,
} from "@/lib/db/skill-resources"
import { parseSkillMarkdown, serializeSkill, skillFilename } from "@/lib/claude/skills-io"
import { isTauri } from "@/lib/tauri"
import type { Skill, SkillResource } from "@/lib/claude/types"

export interface SyncResult {
  pushed: number
  pulled: number
  skipped: number
  errors: { name: string; error: string }[]
}

const TIMESTAMP_FUDGE_MS = 1000

function slug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "skill"
  )
}

/**
 * Hash skill + resources. Used for `syncFingerprint`. Web-mode runs use
 * `crypto.subtle`; if unavailable we fall back to a stringified hash so
 * the function is callable in tests too.
 */
async function fingerprint(skill: Skill, resources: SkillResource[]): Promise<string> {
  const md = serializeSkill(skill)
  const stable = JSON.stringify({
    md,
    res: resources
      .map((r) => ({
        path: r.path,
        kind: r.kind,
        size: r.size,
        encoding: r.encoding,
        content: r.content,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  })
  if (typeof crypto !== "undefined" && crypto.subtle && typeof TextEncoder !== "undefined") {
    const buf = new TextEncoder().encode(stable)
    const digest = await crypto.subtle.digest("SHA-256", buf)
    const bytes = new Uint8Array(digest)
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  }
  // Fallback: simple non-cryptographic hash.
  let h = 0
  for (let i = 0; i < stable.length; i++) {
    h = ((h << 5) - h + stable.charCodeAt(i)) | 0
  }
  return `${(h >>> 0).toString(16)}-${stable.length}`
}

function toNativeResources(resources: SkillResource[]): NativeSkillResource[] {
  return resources.map((r) => ({
    kind: r.kind,
    path: r.path,
    name: r.name,
    content: r.content,
    encoding: r.encoding ?? "utf-8",
    mimeType: r.mimeType,
    size: r.size ?? 0,
  }))
}

function fromNativeResources(
  resources: NativeSkillResource[],
  skillId: string
): SkillResourceDraft[] {
  return resources.map((r) => ({
    skillId,
    kind: r.kind,
    name: r.name,
    path: r.path,
    content: r.content,
    encoding: r.encoding,
    mimeType: r.mimeType,
    size: r.size,
  }))
}

/**
 * Push every Dexie skill (excluding built-ins) to ~/.claude/skills/. Updates
 * each row's `nativeDirectory`, `syncFingerprint`, `lastSyncedAt`. Built-ins
 * are skipped because they're not user-edited content.
 */
export async function pushAllToNative(): Promise<SyncResult> {
  const result: SyncResult = { pushed: 0, pulled: 0, skipped: 0, errors: [] }
  if (!isTauri()) {
    return { ...result, errors: [{ name: "(env)", error: "Desktop only." }] }
  }
  const all = await listSkills()
  for (const skill of all) {
    if (skill.isBuiltIn || (skill.source ?? "custom") === "builtin") {
      result.skipped += 1
      continue
    }
    try {
      const resources = await listResourcesForSkill(skill.id)
      const dirName = skill.nativeDirectory
        ? skill.nativeDirectory.split(/[\\/]/).pop() || slug(skill.name)
        : slug(skill.name)
      const request: InstallSkillRequest = {
        dirName,
        content: serializeSkill(skill),
        resources: toNativeResources(resources),
        clean: true,
      }
      const response = await skillsInstallNative(request)
      const fp = await fingerprint(skill, resources)
      await updateSkill(skill.id, {
        nativeDirectory: response.directory,
        syncOrigin: "frontend",
        syncFingerprint: fp,
        lastSyncedAt: Date.now(),
        lastSyncError: null,
      })
      result.pushed += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await updateSkill(skill.id, {
        lastSyncError: message,
        lastSyncedAt: Date.now(),
      })
      result.errors.push({ name: skill.name, error: message })
    }
  }
  return result
}

/**
 * Pull every skill from ~/.claude/skills/, importing or updating Dexie
 * rows. Each on-disk skill is matched by `nativeDirectory` first, then by
 * name. Existing rows that are newer than the on-disk file are left alone.
 */
export async function pullAllFromNative(): Promise<SyncResult> {
  const result: SyncResult = { pushed: 0, pulled: 0, skipped: 0, errors: [] }
  if (!isTauri()) {
    return { ...result, errors: [{ name: "(env)", error: "Desktop only." }] }
  }
  const native: NativeSkill[] = await skillsScanNative()
  if (native.length === 0) return result

  const local = await listSkills()
  const byDir = new Map<string, Skill>()
  const byName = new Map<string, Skill>()
  for (const s of local) {
    if (s.nativeDirectory) byDir.set(s.nativeDirectory, s)
    byName.set(s.name.toLowerCase(), s)
  }

  for (const skill of native) {
    try {
      const { draft } = parseSkillMarkdown(skill.content, {
        fallbackName: skill.dirName,
      })
      const drafts = [
        {
          ...draft,
          source: "imported" as const,
          syncOrigin: "native" as const,
          nativeDirectory: skill.filePath.replace(/SKILL\.md$/i, "").replace(/[\\/]+$/, ""),
        },
      ]
      const matchByDir = byDir.get(drafts[0].nativeDirectory!)
      const matchByName = byName.get(drafts[0].name.toLowerCase())
      const existing = matchByDir ?? matchByName

      if (existing) {
        const stale = (existing.updatedAt ?? 0) < Date.now() - TIMESTAMP_FUDGE_MS // assume native wins unless our row is fresher
        if (!stale) {
          result.skipped += 1
          continue
        }
        await updateSkill(existing.id, {
          name: drafts[0].name,
          description: drafts[0].description,
          content: drafts[0].content,
          allowedTools: drafts[0].allowedTools,
          tags: drafts[0].tags,
          category: drafts[0].category,
          version: drafts[0].version,
          author: drafts[0].author,
          license: drafts[0].license,
          source: "imported",
          syncOrigin: "native",
          nativeDirectory: drafts[0].nativeDirectory,
          lastSyncedAt: Date.now(),
          lastSyncError: null,
        })
        await replaceResourcesForSkill(
          existing.id,
          fromNativeResources(skill.resources, existing.id)
        )
      } else {
        const report = await bulkImportSkills(drafts, "skip")
        if (report.created > 0) {
          // Look up the freshly-created row to attach resources.
          const refreshed = await listSkills()
          const created = refreshed.find(
            (r) => r.name.toLowerCase() === drafts[0].name.toLowerCase()
          )
          if (created) {
            await replaceResourcesForSkill(
              created.id,
              fromNativeResources(skill.resources, created.id)
            )
          }
        }
      }
      result.pulled += 1
    } catch (err) {
      result.errors.push({
        name: skill.dirName,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return result
}

/** Suggested filename for a skill — used by the on-disk file listing. */
export function suggestedFilename(skill: Skill): string {
  return skillFilename(skill.name)
}
