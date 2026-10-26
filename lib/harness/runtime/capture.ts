/**
 * Capture an agent's current harness as a snapshot (ADR-0237).
 *
 * Reads the agent's effective profile (variants resolved), the library skills
 * it references with their resources, and the MCP servers that are live for
 * it, then builds a content-addressed snapshot. A capture whose content hash
 * matches a snapshot already stored for the agent reuses that snapshot, so the
 * same harness is one row however often it is captured.
 *
 * Skills that cannot be edited stay out of the harness and are carried by id:
 * product built-ins (delivered by their own catalog), disabled skills (they do
 * not run) and ids that no longer resolve. Adoption keeps those ids exactly as
 * they were.
 */

import type { Character, McpServer, Skill, SkillResource } from "@cognia/agent-config-types"
import type { HarnessScope, HarnessSnapshotV1 } from "@/types/harness/snapshot"
import {
  buildHarnessSnapshot,
  componentsFromCharacter,
  computeRuntimeFingerprint,
  executionConfigFromCharacter,
  harnessContentHash,
  type CapturedSkillInput,
} from "../snapshot"

export interface CaptureDeps {
  resolveCharacter(id: string): Promise<Character | undefined>
  listSkills(ids: string[]): Promise<Skill[]>
  listResources(skillId: string): Promise<SkillResource[]>
  listEnabledMcpServers(): Promise<McpServer[]>
  isBuiltInSkill(skill: Skill): boolean
  findSnapshotByHash(
    characterId: string,
    contentHash: string
  ): Promise<HarnessSnapshotV1 | undefined>
  putSnapshot(snapshot: HarnessSnapshotV1): Promise<void>
  appVersion: string
  newId(): string
  now(): number
}

export class HarnessCaptureError extends Error {
  constructor(
    readonly code: "agent-not-found" | "external-runtime",
    message: string
  ) {
    super(message)
    this.name = "HarnessCaptureError"
  }
}

export interface CapturedHarness {
  snapshot: HarnessSnapshotV1
  /** The agent's effective profile at capture time. */
  character: Character
  /** Library skills the harness carries, with their resources (for drift checks). */
  skills: CapturedSkillInput[]
  /** Skill ids the agent references that are not part of the editable harness. */
  carriedSkillIds: string[]
  /** MCP servers live for the agent. */
  enabledMcpServerIds: string[]
  /** Whether the snapshot row was reused from an earlier identical capture. */
  reused: boolean
}

/** Why an agent cannot be evolved, or `null` when it can. */
export function unsupportedReason(character: Character): string | null {
  const kind = character.runtime?.kind
  if (kind && kind !== "builtin") {
    return "This agent runs on an external runtime whose prompt and tool loop Cognia does not assemble; its harness cannot be probed here."
  }
  return null
}

export async function captureHarness(
  characterId: string,
  options: { scope: HarnessScope; projectId?: string },
  deps: CaptureDeps
): Promise<CapturedHarness> {
  const character = await deps.resolveCharacter(characterId)
  if (!character) throw new HarnessCaptureError("agent-not-found", `Agent ${characterId} not found`)
  const unsupported = unsupportedReason(character)
  if (unsupported) throw new HarnessCaptureError("external-runtime", unsupported)

  const ids = [...new Set(character.skillIds ?? [])]
  const rows = await deps.listSkills(ids)
  const byId = new Map(rows.map((r) => [r.id, r]))
  const editable: Skill[] = []
  const carriedSkillIds: string[] = []
  for (const id of ids) {
    const row = byId.get(id)
    if (!row || deps.isBuiltInSkill(row) || row.status === "disabled") carriedSkillIds.push(id)
    else editable.push(row)
  }
  const skills: CapturedSkillInput[] = await Promise.all(
    editable.map(async (skill) => ({ skill, resources: await deps.listResources(skill.id) }))
  )
  const components = await componentsFromCharacter(character, skills)
  const execution = executionConfigFromCharacter(character)
  const live = new Set((await deps.listEnabledMcpServers()).map((s) => s.id))
  const enabledMcpServerIds = (character.mcpServerIds ?? []).filter((id) => live.has(id)).sort()
  const runtimeFingerprint = await computeRuntimeFingerprint({
    appVersion: deps.appVersion,
    runtimeKind: character.runtime?.kind ?? "builtin",
    ...(character.providerId ? { providerId: character.providerId } : {}),
    ...(character.model ? { model: character.model } : {}),
    enabledMcpServerIds,
  })

  const contentHash = await harnessContentHash(components, execution)
  const existing = await deps.findSnapshotByHash(character.id, contentHash)
  if (existing && existing.runtimeFingerprint === runtimeFingerprint) {
    return {
      snapshot: existing,
      character,
      skills,
      carriedSkillIds,
      enabledMcpServerIds,
      reused: true,
    }
  }
  const snapshot = await buildHarnessSnapshot({
    id: deps.newId(),
    characterId: character.id,
    characterName: character.name,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    scope: options.scope,
    components,
    execution,
    runtimeFingerprint,
    origin: { kind: "captured" },
    ...(character.harness?.adoptedSnapshotId
      ? { parentId: character.harness.adoptedSnapshotId }
      : {}),
    createdAt: deps.now(),
  })
  await deps.putSnapshot(snapshot)
  return { snapshot, character, skills, carriedSkillIds, enabledMcpServerIds, reused: false }
}

/** Production dependencies. */
export async function defaultCaptureDeps(): Promise<CaptureDeps> {
  const [characters, skills, resources, mcp, catalog, store, version] = await Promise.all([
    import("@/lib/db/characters"),
    import("@/lib/db/skills"),
    import("@/lib/db/skill-resources"),
    import("@/lib/db/mcp-servers"),
    import("@/lib/skills/built-in-catalog"),
    import("@/lib/db/harness-evolution"),
    import("@/lib/app-version"),
  ])
  return {
    resolveCharacter: characters.resolveCharacterById,
    listSkills: skills.listSkillsByIds,
    listResources: resources.listResourcesForSkill,
    listEnabledMcpServers: () => mcp.listEnabledMcpServers(),
    isBuiltInSkill: (skill) =>
      Boolean(
        skill.isBuiltIn ||
        catalog.resolveBuiltinSkillIdentity(skill.id) ||
        catalog.resolveBuiltinSkillIdentity(skill.canonicalId ?? "")
      ),
    findSnapshotByHash: store.findHarnessSnapshotByHash,
    putSnapshot: store.putHarnessSnapshot,
    appVersion: version.APP_VERSION,
    newId: () => crypto.randomUUID(),
    now: Date.now,
  }
}
