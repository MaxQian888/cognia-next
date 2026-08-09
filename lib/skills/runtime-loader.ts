import type { Skill, SkillResource } from "@cognia/agent-config-types"
import { getSkill as getStoredSkill, recordSkillUsage } from "@/lib/db/skills"
import { listResourcesForSkill } from "@/lib/db/skill-resources"
import { validateResourcePath } from "@/lib/skills/bundle/limits"

export const MAX_SKILL_RESOURCE_TEXT_BYTES = 64 * 1024

interface SkillLoadContext {
  allowedSkillIds: Set<string>
  explicitSkillIds: Set<string>
  loadedSkillIds: Set<string>
  getSkill(id: string): Promise<Skill | undefined>
  listResources(skillId: string): Promise<SkillResource[]>
  recordUsage(ids: string[]): Promise<void>
}

export interface RuntimeLoaderDeps {
  listResources(skillId: string): Promise<SkillResource[]>
  recordUsage(ids: string[]): Promise<void>
}

export interface CreateSkillLoadContextInput {
  sessionId: string
  allowedSkillIds: Iterable<string>
  explicitSkillIds?: Iterable<string>
  getSkill?: SkillLoadContext["getSkill"]
  listResources?: SkillLoadContext["listResources"]
  recordUsage?: SkillLoadContext["recordUsage"]
}

export interface SkillResourceManifestEntry {
  path: string
  kind: SkillResource["kind"]
  encoding: "utf-8" | "base64"
  mimeType?: string
  size: number
  inline: boolean
}

const contexts = new Map<string, SkillLoadContext>()

export function createSkillLoadContext(input: CreateSkillLoadContextInput): void {
  contexts.set(input.sessionId, {
    allowedSkillIds: new Set(input.allowedSkillIds),
    explicitSkillIds: new Set(input.explicitSkillIds ?? []),
    loadedSkillIds: new Set(),
    getSkill: input.getSkill ?? getStoredSkill,
    listResources: input.listResources ?? listResourcesForSkill,
    recordUsage: input.recordUsage ?? recordSkillUsage,
  })
}

export function releaseSkillLoadContext(sessionId: string): void {
  contexts.delete(sessionId)
}

/** Compatibility registration seam used by send-option assembly with already-resolved rows. */
export function registerSkillLoadContext(
  sessionId: string,
  input: { skills: readonly Skill[]; explicitSkillIds?: Iterable<string> }
): void {
  const byId = new Map(input.skills.map((skill) => [skill.id, skill]))
  createSkillLoadContext({
    sessionId,
    allowedSkillIds: byId.keys(),
    explicitSkillIds: input.explicitSkillIds,
    getSkill: async (id) => byId.get(id),
  })
}

export const clearSkillLoadContext = releaseSkillLoadContext

function requireContext(sessionId: string, skillId: string): SkillLoadContext {
  const context = contexts.get(sessionId)
  if (!context) throw new Error(`No active skill load context for session "${sessionId}".`)
  if (!context.allowedSkillIds.has(skillId)) {
    throw new Error(`Skill "${skillId}" is not available in this session.`)
  }
  return context
}

function byteSize(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

function manifestEntry(resource: SkillResource): SkillResourceManifestEntry {
  return {
    path: resource.path,
    kind: resource.kind,
    encoding: resource.encoding ?? "utf-8",
    mimeType: resource.mimeType,
    size: resource.size ?? byteSize(resource.content),
    inline: resource.inline === true,
  }
}

export function renderSkillWithResources(
  skill: Skill,
  resources: readonly SkillResource[]
): string {
  let remaining = MAX_SKILL_RESOURCE_TEXT_BYTES
  const inlineSections: string[] = []
  for (const resource of resources) {
    if (!resource.inline || (resource.encoding ?? "utf-8") !== "utf-8") continue
    const bytes = byteSize(resource.content)
    if (bytes > remaining) continue
    remaining -= bytes
    inlineSections.push(`## Resource: ${resource.path}\n\n${resource.content}`)
  }
  const manifest = resources.map(manifestEntry)
  return [
    `## ${skill.name}`,
    skill.content.trim(),
    manifest.length > 0
      ? `### Resources\n\n${manifest
          .map((entry) => `- ${entry.path} (${entry.encoding}, ${entry.size} bytes)`)
          .join("\n")}`
      : "",
    ...inlineSections,
  ]
    .filter(Boolean)
    .join("\n\n")
}

export async function loadSkillForSession(
  sessionId: string,
  skillId: string,
  deps?: RuntimeLoaderDeps
): Promise<
  | { ok: true; skill: Skill; resources: SkillResourceManifestEntry[]; content: string }
  | { ok: false; code: "missing_context" | "out_of_scope" | "not_found"; error: string }
> {
  let context: SkillLoadContext
  try {
    context = requireContext(sessionId, skillId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      code: contexts.has(sessionId) ? "out_of_scope" : "missing_context",
      error: message,
    }
  }
  const skill = await context.getSkill(skillId)
  if (!skill) return { ok: false, code: "not_found", error: `Skill "${skillId}" no longer exists.` }
  const resources = await (deps?.listResources ?? context.listResources)(skillId)
  if (!context.loadedSkillIds.has(skillId) && !context.explicitSkillIds.has(skillId)) {
    context.loadedSkillIds.add(skillId)
    await (deps?.recordUsage ?? context.recordUsage)([skillId]).catch(() => undefined)
  }
  const manifest = resources.map(manifestEntry)
  const content = [
    renderSkillWithResources(skill, resources).replace(/^## /, "# "),
    resources.some((resource) => !resource.inline || resource.encoding === "base64")
      ? "Use load_skill_resource to read non-inline UTF-8 resources when needed."
      : "",
  ]
    .filter(Boolean)
    .join("\n\n")
  return { ok: true, skill, resources: manifest, content }
}

function sliceUtf8(text: string, offset: number, limit: number): { text: string; end: number } {
  const bytes = new TextEncoder().encode(text)
  let start = Math.min(offset, bytes.byteLength)
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) start += 1
  let end = Math.min(start + limit, bytes.byteLength)
  while (end > start && end < bytes.byteLength && (bytes[end] & 0xc0) === 0x80) end -= 1
  if (end === start && start < bytes.byteLength) {
    end = Math.min(start + 1, bytes.byteLength)
    while (end < bytes.byteLength && (bytes[end] & 0xc0) === 0x80) end += 1
  }
  return { text: new TextDecoder("utf-8").decode(bytes.slice(start, end)), end }
}

export async function loadSkillResourceForSession(
  sessionId: string,
  skillId: string,
  path: string,
  offset = 0,
  requestedLimit = MAX_SKILL_RESOURCE_TEXT_BYTES,
  deps?: RuntimeLoaderDeps
): Promise<
  | {
      ok: true
      path: string
      binary: boolean
      content?: string
      nextOffset?: number
      mimeType?: string
      size: number
    }
  | { ok: false; code: string; error: string }
> {
  let context: SkillLoadContext
  try {
    context = requireContext(sessionId, skillId)
  } catch (error) {
    return {
      ok: false,
      code: contexts.has(sessionId) ? "out_of_scope" : "missing_context",
      error: error instanceof Error ? error.message : String(error),
    }
  }
  const normalizedPath = path.replace(/\\/g, "/")
  const pathError = validateResourcePath(normalizedPath)
  if (pathError) return { ok: false, code: "invalid_path", error: pathError }
  const resource = (await (deps?.listResources ?? context.listResources)(skillId)).find(
    (entry) => entry.path.replace(/\\/g, "/") === normalizedPath
  )
  if (!resource) return { ok: false, code: "not_found", error: `Resource "${path}" not found.` }
  if ((resource.encoding ?? "utf-8") === "base64") {
    const size = resource.size ?? byteSize(resource.content)
    return { ok: true, path: normalizedPath, binary: true, mimeType: resource.mimeType, size }
  }
  const size = byteSize(resource.content)
  offset = Math.max(0, Math.floor(offset))
  const limit = Math.min(MAX_SKILL_RESOURCE_TEXT_BYTES, Math.max(1, Math.floor(requestedLimit)))
  const slice = sliceUtf8(resource.content, offset, limit)
  return {
    ok: true,
    path: normalizedPath,
    binary: false,
    content: slice.text,
    nextOffset: slice.end < size ? slice.end : undefined,
    mimeType: resource.mimeType,
    size,
  }
}
