import type { Skill, SkillResource } from "@cognia/agent-config-types"
import { getSkill as getStoredSkill, recordSkillUsage } from "@/lib/db/skills"
import { listResourcesForSkill } from "@/lib/db/skill-resources"
import { validateResourcePath } from "@/lib/skills/bundle/limits"
import { getCatalogSkill, resolveBuiltinSkillIdentity } from "@/lib/skills/built-in-catalog"
import { loadBuiltInResourceOverlay } from "@/lib/skills/built-in-resource-overlay"

export const MAX_SKILL_RESOURCE_TEXT_BYTES = 64 * 1024

interface SkillLoadContext {
  turnId?: string
  attemptId?: string
  allowedSkillIds: Set<string>
  aliasToSkillId: Map<string, string>
  explicitSkillIds: Set<string>
  allowDisabledSkillIds: Set<string>
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
  /** Optional frozen send identity. When supplied, every load must match it. */
  turnId?: string
  /** Optional retry identity. A retry keeps turnId and replaces attemptId. */
  attemptId?: string
  allowedSkillIds: Iterable<string>
  explicitSkillIds?: Iterable<string>
  /** Request-scoped exceptions such as an onboarding card authorization. */
  allowDisabledSkillIds?: Iterable<string>
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

export interface SkillLoadScope {
  sessionId: string
  turnId?: string
  attemptId?: string
}

type SkillLoadScopeInput = string | SkillLoadScope

function normalizeBuiltInStorageId(id: string): string {
  return resolveBuiltinSkillIdentity(id)?.storageId ?? id
}

function normalizedResourcePath(path: string): string {
  return path.replace(/\\/g, "/")
}

/**
 * Dexie SkillResource rows predate generated resource roles. Join by path to
 * the content-free authoritative manifest before exposing anything to a model.
 */
export function modelReadableResources(
  skillId: string,
  resources: readonly SkillResource[]
): SkillResource[] {
  const identity = resolveBuiltinSkillIdentity(skillId)
  const entry = identity ? getCatalogSkill(identity.bundleId) : undefined
  if (!entry?.resourceManifest?.length) return [...resources]
  const compliancePaths = new Set(
    entry.resourceManifest
      .filter((resource) => resource.role === "compliance")
      .map((resource) => normalizedResourcePath(resource.path))
  )
  return resources.filter((resource) => !compliancePaths.has(normalizedResourcePath(resource.path)))
}

export async function builtInCatalogResources(skillId: string): Promise<SkillResource[]> {
  return (await loadBuiltInResourceOverlay(skillId, { includeCompliance: false })) ?? []
}

async function listRuntimeResources(skillId: string): Promise<SkillResource[]> {
  const stored = await listResourcesForSkill(skillId)
  if (stored.length > 0) return modelReadableResources(skillId, stored)
  return await builtInCatalogResources(skillId)
}

export function createSkillLoadContext(input: CreateSkillLoadContextInput): void {
  const allowedSkillIds = new Set<string>()
  const aliasToSkillId = new Map<string, string>()
  for (const alias of input.allowedSkillIds) {
    const storageId = normalizeBuiltInStorageId(alias)
    allowedSkillIds.add(storageId)
    aliasToSkillId.set(alias, storageId)
    const identity = resolveBuiltinSkillIdentity(alias)
    if (identity) {
      aliasToSkillId.set(identity.bundleId, storageId)
      aliasToSkillId.set(identity.canonicalId, storageId)
      aliasToSkillId.set(identity.storageId, storageId)
    }
  }
  contexts.set(input.sessionId, {
    turnId: input.turnId,
    attemptId: input.attemptId,
    allowedSkillIds,
    aliasToSkillId,
    explicitSkillIds: new Set([...(input.explicitSkillIds ?? [])].map(normalizeBuiltInStorageId)),
    allowDisabledSkillIds: new Set(
      [...(input.allowDisabledSkillIds ?? [])].map(normalizeBuiltInStorageId)
    ),
    loadedSkillIds: new Set(),
    getSkill: input.getSkill ?? getStoredSkill,
    listResources: input.listResources ?? listRuntimeResources,
    recordUsage: input.recordUsage ?? recordSkillUsage,
  })
}

export function releaseSkillLoadContext(sessionId: string): void {
  contexts.delete(sessionId)
}

/** Compatibility registration seam used by send-option assembly with already-resolved rows. */
export function registerSkillLoadContext(
  sessionId: string,
  input: {
    skills: readonly Skill[]
    explicitSkillIds?: Iterable<string>
    allowDisabledSkillIds?: Iterable<string>
    turnId?: string
    attemptId?: string
  }
): void {
  const byId = new Map(input.skills.map((skill) => [skill.id, skill]))
  for (const skill of input.skills) {
    for (const alias of [skill.slug, skill.canonicalId]) {
      if (alias) byId.set(alias, skill)
    }
  }
  createSkillLoadContext({
    sessionId,
    turnId: input.turnId,
    attemptId: input.attemptId,
    allowedSkillIds: byId.keys(),
    explicitSkillIds: input.explicitSkillIds,
    allowDisabledSkillIds: input.allowDisabledSkillIds,
    getSkill: async (id) =>
      byId.get(id) ?? byId.get(resolveBuiltinSkillIdentity(id)?.bundleId ?? ""),
  })
}

export const clearSkillLoadContext = releaseSkillLoadContext

class SkillLoadContextError extends Error {
  constructor(
    readonly code: "missing_context" | "out_of_scope" | "stale_context",
    message: string
  ) {
    super(message)
  }
}

function requireContext(
  scopeInput: SkillLoadScopeInput,
  skillId: string
): { context: SkillLoadContext; skillId: string; sessionId: string } {
  const scope = typeof scopeInput === "string" ? { sessionId: scopeInput } : scopeInput
  const context = contexts.get(scope.sessionId)
  if (!context) {
    throw new SkillLoadContextError(
      "missing_context",
      `No active skill load context for session "${scope.sessionId}".`
    )
  }
  if (
    (context.turnId !== undefined && scope.turnId !== context.turnId) ||
    (context.attemptId !== undefined && scope.attemptId !== context.attemptId)
  ) {
    throw new SkillLoadContextError(
      "stale_context",
      `Skill load context does not match the active turn attempt for session "${scope.sessionId}".`
    )
  }
  const resolvedSkillId = context.aliasToSkillId.get(skillId) ?? normalizeBuiltInStorageId(skillId)
  if (!context.allowedSkillIds.has(resolvedSkillId)) {
    throw new SkillLoadContextError(
      "out_of_scope",
      `Skill "${skillId}" is not available in this session.`
    )
  }
  return { context, skillId: resolvedSkillId, sessionId: scope.sessionId }
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
  resources = modelReadableResources(skill.id, resources)
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
  scope: SkillLoadScopeInput,
  skillId: string,
  deps?: RuntimeLoaderDeps
): Promise<
  | { ok: true; skill: Skill; resources: SkillResourceManifestEntry[]; content: string }
  | {
      ok: false
      code: "missing_context" | "out_of_scope" | "stale_context" | "not_found"
      error: string
    }
> {
  let context: SkillLoadContext
  let resolvedSkillId: string
  try {
    const resolved = requireContext(scope, skillId)
    context = resolved.context
    resolvedSkillId = resolved.skillId
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      code: error instanceof SkillLoadContextError ? error.code : "missing_context",
      error: message,
    }
  }
  const skill = await context.getSkill(resolvedSkillId)
  if (!skill) return { ok: false, code: "not_found", error: `Skill "${skillId}" no longer exists.` }
  if (
    skill.status !== undefined &&
    skill.status !== "enabled" &&
    !context.allowDisabledSkillIds.has(resolvedSkillId)
  ) {
    return {
      ok: false,
      code: "out_of_scope",
      error: `Skill "${skillId}" is ${skill.status} and is not available in this session.`,
    }
  }
  const resources = modelReadableResources(
    resolvedSkillId,
    await (deps?.listResources ?? context.listResources)(resolvedSkillId)
  )
  if (
    !context.loadedSkillIds.has(resolvedSkillId) &&
    !context.explicitSkillIds.has(resolvedSkillId)
  ) {
    context.loadedSkillIds.add(resolvedSkillId)
    await (deps?.recordUsage ?? context.recordUsage)([resolvedSkillId]).catch(() => undefined)
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
  scope: SkillLoadScopeInput,
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
  let resolvedSkillId: string
  try {
    const resolved = requireContext(scope, skillId)
    context = resolved.context
    resolvedSkillId = resolved.skillId
  } catch (error) {
    return {
      ok: false,
      code: error instanceof SkillLoadContextError ? error.code : "missing_context",
      error: error instanceof Error ? error.message : String(error),
    }
  }
  const normalizedPath = normalizedResourcePath(path)
  const pathError = validateResourcePath(normalizedPath)
  if (pathError) return { ok: false, code: "invalid_path", error: pathError }
  const resources = modelReadableResources(
    resolvedSkillId,
    await (deps?.listResources ?? context.listResources)(resolvedSkillId)
  )
  const resource = resources.find((entry) => normalizedResourcePath(entry.path) === normalizedPath)
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
