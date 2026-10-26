/**
 * List and read every agent configuration surface (ADR-0238 §2).
 *
 * The Prompt Center's own listing (`listPromptResources`) supplies every owner
 * it knows, in its order, so this module can never disagree with Settings →
 * Prompts about what exists. Two things are added on top:
 *
 * - Instruction files get their load order and discovery layer, because a
 *   later file's rule silently competes with an earlier one's.
 * - Markdown agent definitions (`.cognia/agents/*.md`), which load as
 *   dispatchable subagents but are not Prompt Center resources.
 *
 * The placeholder the Prompt Center offers for a workspace without an
 * instruction file is left out: there is nothing to read.
 */

import { getSkill } from "@/lib/db/skills"
import { discoverProjectAgentFiles } from "@/lib/claude/instructions/load"
import { joinPath } from "@/lib/claude/instructions/paths"
import type { InstructionSource } from "@/lib/claude/instructions/types"
import { readWorkspaceFileVersioned } from "@/lib/files/workspace-fs"
import { listPromptResources, ownerAdapterFor } from "@/lib/prompts/adapters"
import {
  ABSENT_FILE_VERSION,
  parseInstructionFileKey,
} from "@/lib/prompts/adapters/instruction-files"
import { getPromptDefinition } from "@/lib/prompts/catalog"
import { parseResourceKey, type PromptResourceSummary } from "@/lib/prompts/resources"
import { readPromptSlot } from "@/lib/prompts/service"
import type { PromptTargetRef } from "@/lib/prompts/types"
import { useSettingsStore } from "@/stores/settings"
import type {
  AgentConfigSkillFacts,
  AgentConfigSurface,
  AgentConfigSurfaceDocument,
  AgentConfigSurfaceListing,
} from "./types"
import { resolveAgentConfigWorkspace, type AgentConfigWorkspace } from "./workspace"

const INSTRUCTION_LAYERS = new Set<string>([
  "global",
  "project",
  "instructions-dir",
  "extra",
  "import",
])

export interface AgentFileRef {
  dir: string
  name: string
}

export function agentFileKey(ref: AgentFileRef): string {
  return `agent-file:${encodeURIComponent(ref.dir)}|${encodeURIComponent(ref.name)}`
}

export function parseAgentFileKey(key: string): AgentFileRef {
  const { source, id } = parseResourceKey(key)
  const [dir, name] = id.split("|")
  if (source !== "agent-file" || !dir || !name) {
    throw new Error(`not an agent file key: ${key}`)
  }
  return { dir: decodeURIComponent(dir), name: decodeURIComponent(name) }
}

function fromPromptResource(resource: PromptResourceSummary): AgentConfigSurface {
  return {
    key: resource.key,
    source: resource.source,
    kind: resource.kind,
    name: resource.name ?? resource.promptId ?? resource.key,
    ...(resource.detail ? { detail: resource.detail } : {}),
    builtIn: resource.builtIn,
    modified: resource.modified,
    edit: resource.edit,
    ...(resource.promptId ? { promptId: resource.promptId } : {}),
    ...(resource.group ? { group: resource.group } : {}),
    ...(resource.unavailable ? { unavailable: true as const } : {}),
  }
}

export interface AgentConfigSurfaceDeps {
  listResources?: typeof listPromptResources
  discoverAgentFiles?: typeof discoverProjectAgentFiles
}

export async function listAgentConfigSurfaces(
  workspaceId: string | null | undefined,
  deps: AgentConfigSurfaceDeps = {}
): Promise<AgentConfigSurfaceListing> {
  const workspace = resolveAgentConfigWorkspace(workspaceId)
  const listResources = deps.listResources ?? listPromptResources
  const discoverAgentFiles = deps.discoverAgentFiles ?? discoverProjectAgentFiles
  const listing = await listResources(workspace.promptContext)
  const failed: AgentConfigSurfaceListing["failed"] = [...listing.failed]

  const surfaces: AgentConfigSurface[] = []
  let instructionOrder = 0
  for (const resource of listing.resources) {
    if (resource.source !== "instruction-file") {
      surfaces.push(fromPromptResource(resource))
      continue
    }
    // The offered-but-absent file: the adapter lists it with no layer.
    if (!resource.detail || !INSTRUCTION_LAYERS.has(resource.detail)) continue
    const ref = parseInstructionFileKey(resource.key)
    surfaces.push({
      ...fromPromptResource(resource),
      loadOrder: instructionOrder++,
      layer: resource.detail as InstructionSource,
      path: joinPath(ref.root, ref.name),
    })
  }

  if (workspace.roots.length > 0) {
    try {
      const config = useSettingsStore.getState().settings?.instructions
      const files = await discoverAgentFiles({ roots: workspace.roots, config })
      files.forEach((file, index) => {
        surfaces.push({
          key: agentFileKey({ dir: file.dir, name: file.name }),
          source: "agent-file",
          kind: "agent-definition",
          name: file.id,
          detail: file.name,
          builtIn: false,
          modified: true,
          edit: "source",
          loadOrder: index,
          layer: "agent-dir",
          path: file.absPath,
        })
      })
    } catch {
      failed.push("agent-file")
    }
  }

  return { workspaceId: workspace.id, surfaces, failed }
}

function skillFacts(
  skill: NonNullable<Awaited<ReturnType<typeof getSkill>>>
): AgentConfigSkillFacts {
  return {
    ...(skill.description ? { description: skill.description } : {}),
    status: skill.status === "disabled" ? "disabled" : "enabled",
    origin: skill.isBuiltIn ? "builtin" : (skill.source ?? "custom"),
    usageCount: skill.usageCount ?? 0,
    ...(skill.lastUsedAt ? { lastUsedAt: skill.lastUsedAt } : {}),
    ...(skill.allowedTools?.length ? { allowedTools: [...skill.allowedTools] } : {}),
    validationErrorCount: skill.validationErrors?.length ?? 0,
  }
}

/** `<scope>:<targetId>:<rev>` — the slot an edit targets and the revision it saw. */
export function codeSlotVersion(target: PromptTargetRef, rev: number): string {
  return `${target.scope}:${encodeURIComponent(target.targetId)}:${rev}`
}

export function parseCodeSlotVersion(version: string): { target: PromptTargetRef; rev: number } {
  const [scope, targetId, rev] = version.split(":")
  const parsedRev = Number(rev)
  if ((scope !== "account" && scope !== "workspace") || !Number.isInteger(parsedRev)) {
    throw new Error(`not a code slot version: ${version}`)
  }
  return { target: { scope, targetId: decodeURIComponent(targetId ?? "") }, rev: parsedRev }
}

/**
 * The scope a governance edit of a code slot lands in: the workspace when the
 * slot allows it and a workspace is in scope, else the account.
 */
export function codeSlotTarget(
  scopes: readonly string[],
  workspace: AgentConfigWorkspace
): PromptTargetRef {
  return workspace.id && scopes.includes("workspace")
    ? { scope: "workspace", targetId: workspace.id }
    : { scope: "account", targetId: "" }
}

async function readCodeSlot(
  key: string,
  workspace: AgentConfigWorkspace
): Promise<AgentConfigSurfaceDocument | undefined> {
  const promptId = parseResourceKey(key).id
  const def = getPromptDefinition(promptId)
  if (!def) return undefined
  const target = codeSlotTarget(def.scopes, workspace)
  const own = await readPromptSlot(promptId, target)
  // A workspace slot without its own text inherits the account's.
  const inherited =
    !own.active && target.scope !== "account"
      ? await readPromptSlot(promptId, { scope: "account", targetId: "" })
      : undefined
  const text = own.active?.body ?? inherited?.active?.body ?? def.defaultBody
  return {
    key,
    text,
    version: codeSlotVersion(target, own.binding?.rev ?? 0),
    ...(text !== def.defaultBody ? { baseText: def.defaultBody } : {}),
    ...(def.operation === "inspect-only" ? { readOnlyReason: "immutable" as const } : {}),
  }
}

async function readAgentFile(key: string): Promise<AgentConfigSurfaceDocument> {
  const ref = parseAgentFileKey(key)
  const file = await readWorkspaceFileVersioned(ref.dir, ref.name)
  return { key, text: file.content, version: file.sha256 }
}

export async function readAgentConfigSurface(
  key: string,
  workspaceId: string | null | undefined
): Promise<AgentConfigSurfaceDocument | undefined> {
  const workspace = resolveAgentConfigWorkspace(workspaceId)
  const { source, id } = parseResourceKey(key)
  if (source === "agent-file") return readAgentFile(key)
  if (source === "code") return readCodeSlot(key, workspace)
  const adapter = ownerAdapterFor(key)
  if (!adapter) return undefined
  const document = await adapter.read(key, workspace.promptContext)
  if (!document) return undefined
  // An instruction file that does not exist yet reads as empty; it is not a surface.
  if (source === "instruction-file" && document.version === ABSENT_FILE_VERSION) return undefined
  const skill = source === "skill" ? await getSkill(id) : undefined
  return {
    key: document.key,
    text: document.text,
    ...(document.version ? { version: document.version } : {}),
    ...(document.readOnlyReason ? { readOnlyReason: document.readOnlyReason } : {}),
    ...(document.baseText !== undefined ? { baseText: document.baseText } : {}),
    ...(skill ? { skill: skillFacts(skill) } : {}),
  }
}
