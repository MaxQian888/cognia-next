import { validateSkill } from "@/lib/skills/validate"
import { parseCodexOpenaiYamlForEdit } from "@/lib/skills/bundle/codex-yaml"
import { getDb } from "./schema"

export type SkillWorkspaceSaveFile =
  | { id: string; kind: "main"; baseline: string; content: string }
  | { id: string; kind: "codex"; baseline: string; content: string }
  | {
      id: string
      kind: "resource"
      resourceId: string
      baseline: string
      content: string
    }

export type SkillWorkspaceSaveResult =
  | { status: "clean"; savedFileIds: [] }
  | { status: "saved"; savedFileIds: string[] }
  | { status: "blocked" | "conflict" | "error"; fileIds: string[]; message: string }

/**
 * Optimistically save one or more open Skill files as a single Dexie unit.
 * Content baselines, rather than `updatedAt`, detect conflicts so metadata-only
 * edits never create a false conflict.
 */
export async function saveSkillWorkspace(input: {
  skillId: string
  files: SkillWorkspaceSaveFile[]
}): Promise<SkillWorkspaceSaveResult> {
  const dirty = input.files.filter((file) => file.content !== file.baseline)
  if (dirty.length === 0) return { status: "clean", savedFileIds: [] }

  const db = getDb()
  try {
    return await db.transaction("rw", db.skills, db.skillResources, async () => {
      const skill = await db.skills.get(input.skillId)
      if (!skill) {
        return {
          status: "error" as const,
          fileIds: dirty.map((file) => file.id),
          message: "Skill no longer exists.",
        }
      }

      const conflicts: string[] = []
      const resourceRows = new Map<string, Awaited<ReturnType<typeof db.skillResources.get>>>()
      for (const file of dirty) {
        if (file.kind === "main") {
          if (skill.content !== file.baseline) conflicts.push(file.id)
          continue
        }
        if (file.kind === "codex") {
          if ((skill.codexOpenAiYaml ?? "") !== file.baseline) conflicts.push(file.id)
          continue
        }
        const row = await db.skillResources.get(file.resourceId)
        resourceRows.set(file.resourceId, row)
        if (!row || row.skillId !== input.skillId || row.content !== file.baseline) {
          conflicts.push(file.id)
        }
      }
      if (conflicts.length > 0) {
        return {
          status: "conflict" as const,
          fileIds: conflicts,
          message: "One or more files changed outside this editor.",
        }
      }

      const main = dirty.find((file) => file.kind === "main")
      if (main?.kind === "main") {
        const issues = validateSkill({ ...skill, content: main.content })
        if (issues.some((issue) => issue.severity === "runtime")) {
          return {
            status: "blocked" as const,
            fileIds: [main.id],
            message:
              issues.find((issue) => issue.severity === "runtime")?.message ?? "Save blocked.",
          }
        }
      }

      const codex = dirty.find((file) => file.kind === "codex")
      let codexInvocationPolicy: "implicit" | "explicit" | undefined
      if (codex?.kind === "codex") {
        try {
          const parsed = parseCodexOpenaiYamlForEdit(codex.content)
          const allowImplicit = parsed.meta.policy?.allowImplicitInvocation
          if (allowImplicit !== undefined) {
            codexInvocationPolicy = allowImplicit ? "implicit" : "explicit"
          }
        } catch (error) {
          return {
            status: "blocked" as const,
            fileIds: [codex.id],
            message: error instanceof Error ? error.message : String(error),
          }
        }
      }

      const now = Date.now()
      if (main?.kind === "main") {
        await db.skills.update(input.skillId, {
          content: main.content,
          validationErrors: validateSkill({ ...skill, content: main.content }),
          syncFingerprint: undefined,
          updatedAt: now,
        })
      }
      if (codex?.kind === "codex") {
        await db.skills.update(input.skillId, {
          codexOpenAiYaml: codex.content,
          ...(codexInvocationPolicy ? { invocationPolicy: codexInvocationPolicy } : {}),
          syncFingerprint: undefined,
          updatedAt: now,
        })
      }
      for (const file of dirty) {
        if (file.kind !== "resource") continue
        await db.skillResources.update(file.resourceId, { content: file.content, updatedAt: now })
      }
      if (dirty.some((file) => file.kind === "resource")) {
        await db.skills.update(input.skillId, { syncFingerprint: undefined, updatedAt: now })
      }
      return { status: "saved" as const, savedFileIds: dirty.map((file) => file.id) }
    })
  } catch (error) {
    return {
      status: "error",
      fileIds: dirty.map((file) => file.id),
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
