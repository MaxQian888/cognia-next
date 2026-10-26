/**
 * Harness snapshots: capture, content hash, fork, diff (ADR-0237).
 *
 * Pure. The runtime adapter (`runtime/capture.ts`) loads the effective agent,
 * its skills and resources, and the enabled MCP servers, then calls
 * {@link buildHarnessSnapshot}. Hashing is RFC 8785 canonical JSON under
 * SHA-256, so the same harness always has the same `contentHash` whatever the
 * key order of the objects it was built from.
 */

import type { Character, Skill, SkillResource } from "@cognia/agent-config-types"
import { canonicalizeJson } from "@/lib/plugin/character-pack/canonical-json"
import { sha256Hex } from "@/lib/share/hash"
import { deriveSkillSlug } from "@/lib/skills/slug"
import type {
  HarnessComponentName,
  HarnessComponentsV1,
  HarnessExecutionConfigV1,
  HarnessScope,
  HarnessSkillV1,
  HarnessSnapshotDiff,
  HarnessSnapshotOrigin,
  HarnessSnapshotV1,
} from "@/types/harness/snapshot"
import { HARNESS_SNAPSHOT_SCHEMA_VERSION } from "@/types/harness/snapshot"
import { TOOL_RULE_ENGINE_VERSION } from "./tool-rules"
import { alwaysOnText, componentOfPath, componentsToTree, diffTrees } from "./tree"

/** Drop `undefined` and functions so canonical JSON accepts the value. */
export function toJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T
}

/** SHA-256 hex over the canonical JSON of a value. */
export async function canonicalHash(value: unknown): Promise<string> {
  return sha256Hex(canonicalizeJson(toJsonValue(value)))
}

/** Hash of a library skill's content and resources, for drift detection. */
export async function skillSourceHash(
  skill: Pick<Skill, "content" | "description" | "allowedTools">,
  resources: readonly Pick<SkillResource, "path" | "content" | "encoding">[]
): Promise<string> {
  return canonicalHash({
    content: skill.content,
    description: skill.description ?? "",
    allowedTools: skill.allowedTools ?? [],
    resources: [...resources]
      .map((r) => ({ path: r.path, content: r.content, encoding: r.encoding ?? "utf-8" }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  })
}

export interface CapturedSkillInput {
  skill: Skill
  resources: SkillResource[]
}

/** Turn a library skill into the harness form, keeping its source identity. */
export async function harnessSkillFromLibrary(input: CapturedSkillInput): Promise<HarnessSkillV1> {
  const { skill, resources } = input
  const key = deriveSkillSlug(skill)
  return {
    key,
    name: skill.name,
    description: skill.description?.trim() ?? "",
    content: skill.content,
    ...(skill.allowedTools?.length ? { allowedTools: [...skill.allowedTools] } : {}),
    resources: resources
      .filter((r) => r.kind === "script" || r.kind === "reference" || r.kind === "asset")
      .map((r) => ({
        path: r.path,
        kind: r.kind,
        content: r.content,
        encoding: r.encoding ?? "utf-8",
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    sourceSkillId: skill.id,
    sourceHash: await skillSourceHash(skill, resources),
  }
}

/** The editable components of an effective agent, given its skills. */
export async function componentsFromCharacter(
  character: Pick<Character, "systemPrompt" | "harness">,
  skills: readonly CapturedSkillInput[]
): Promise<HarnessComponentsV1> {
  const harness = character.harness ?? {}
  const captured = await Promise.all(skills.map(harnessSkillFromLibrary))
  // Two library skills can derive the same slug; keep the first, suffix the rest.
  const seen = new Set<string>()
  for (const skill of captured) {
    let key = skill.key
    let n = 2
    while (seen.has(key)) key = `${skill.key}-${n++}`
    seen.add(key)
    skill.key = key
  }
  return {
    systemPrompt: character.systemPrompt ?? "",
    guardrails: harness.guardrails ?? "",
    memory: harness.memory ?? "",
    toolGuidance: harness.toolGuidance ?? "",
    skills: captured.sort((a, b) => a.key.localeCompare(b.key)),
    subagents: [...(harness.subagents ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    toolRules: [...(harness.toolRules ?? [])],
  }
}

/** The captured (never editable) execution configuration of an agent. */
export function executionConfigFromCharacter(
  character: Character,
  runtimeKind?: string
): HarnessExecutionConfigV1 {
  return toJsonValue({
    providerId: character.providerId,
    model: character.model,
    permissionMode: character.permissionMode,
    allowedTools: character.allowedTools ? [...character.allowedTools].sort() : undefined,
    disallowedTools: character.disallowedTools ? [...character.disallowedTools].sort() : undefined,
    mcpServerIds: character.mcpServerIds ? [...character.mcpServerIds].sort() : undefined,
    sandboxEnabled: character.sandboxEnabled,
    workspaceConfinementEnabled: character.workspaceConfinementEnabled,
    runtimeKind: runtimeKind ?? character.runtime?.kind,
  })
}

export interface RuntimeFingerprintInput {
  appVersion: string
  runtimeKind?: string
  providerId?: string
  model?: string
  enabledMcpServerIds?: readonly string[]
}

/** Fingerprint of everything outside the harness that can change how it behaves. */
export async function computeRuntimeFingerprint(input: RuntimeFingerprintInput): Promise<string> {
  const hash = await canonicalHash({
    appVersion: input.appVersion,
    runtimeKind: input.runtimeKind ?? "",
    providerId: input.providerId ?? "",
    model: input.model ?? "",
    mcp: [...(input.enabledMcpServerIds ?? [])].sort(),
    toolRules: TOOL_RULE_ENGINE_VERSION,
  })
  return `hrf1-${hash.slice(0, 32)}`
}

/** Content hash of a harness: components plus the execution configuration it ran with. */
export async function harnessContentHash(
  components: HarnessComponentsV1,
  execution: HarnessExecutionConfigV1
): Promise<string> {
  return canonicalHash({ components, execution })
}

export interface BuildSnapshotInput {
  id: string
  characterId: string
  characterName: string
  projectId?: string
  scope: HarnessScope
  components: HarnessComponentsV1
  execution: HarnessExecutionConfigV1
  runtimeFingerprint: string
  origin: HarnessSnapshotOrigin
  parentId?: string
  createdAt: number
}

export async function buildHarnessSnapshot(input: BuildSnapshotInput): Promise<HarnessSnapshotV1> {
  const components = toJsonValue(input.components)
  const execution = toJsonValue(input.execution)
  return {
    schemaVersion: HARNESS_SNAPSHOT_SCHEMA_VERSION,
    id: input.id,
    contentHash: await harnessContentHash(components, execution),
    ...(input.parentId ? { parentId: input.parentId } : {}),
    characterId: input.characterId,
    characterName: input.characterName,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    scope: input.scope,
    components,
    execution,
    runtimeFingerprint: input.runtimeFingerprint,
    origin: input.origin,
    createdAt: input.createdAt,
  }
}

/**
 * A new snapshot from an existing one with different components. The parent is
 * never modified; the child records it as `parentId`.
 */
export async function forkHarnessSnapshot(
  parent: HarnessSnapshotV1,
  input: {
    id: string
    components: HarnessComponentsV1
    origin: HarnessSnapshotOrigin
    scope?: HarnessScope
    createdAt: number
  }
): Promise<HarnessSnapshotV1> {
  return buildHarnessSnapshot({
    id: input.id,
    characterId: parent.characterId,
    characterName: parent.characterName,
    ...(parent.projectId ? { projectId: parent.projectId } : {}),
    scope: input.scope ?? parent.scope,
    components: input.components,
    execution: parent.execution,
    runtimeFingerprint: parent.runtimeFingerprint,
    origin: input.origin,
    parentId: parent.id,
    createdAt: input.createdAt,
  })
}

/** Component-level difference between two snapshots (or bare component sets). */
export function diffHarness(
  before: Pick<HarnessSnapshotV1, "components" | "execution">,
  after: Pick<HarnessSnapshotV1, "components" | "execution">
): HarnessSnapshotDiff {
  const tree = diffTrees(componentsToTree(before.components), componentsToTree(after.components))
  const changes: HarnessSnapshotDiff["changes"] = []
  const push = (paths: string[], change: "added" | "removed" | "modified") => {
    for (const path of paths) {
      const component = componentOfPath(path)
      if (component) changes.push({ component, path, change })
    }
  }
  push(tree.added, "added")
  push(tree.removed, "removed")
  push(tree.modified, "modified")
  changes.sort((a, b) => a.path.localeCompare(b.path))
  const components = [...new Set(changes.map((c) => c.component))] as HarnessComponentName[]
  return {
    changes,
    components,
    alwaysOnCharDelta:
      alwaysOnText(after.components).length - alwaysOnText(before.components).length,
    executionChanged:
      canonicalizeJson(toJsonValue(before.execution)) !==
      canonicalizeJson(toJsonValue(after.execution)),
  }
}

/** True when the runtime moved under a snapshot since it was captured. */
export function isSnapshotStale(
  snapshot: Pick<HarnessSnapshotV1, "runtimeFingerprint">,
  currentRuntimeFingerprint: string
): boolean {
  return snapshot.runtimeFingerprint !== currentRuntimeFingerprint
}

/**
 * Library skills whose current content no longer matches what the snapshot
 * captured. A drifted skill means rollouts of this snapshot cannot be reused.
 */
export async function driftedSkills(
  snapshot: Pick<HarnessSnapshotV1, "components">,
  current: ReadonlyMap<string, CapturedSkillInput>
): Promise<string[]> {
  const out: string[] = []
  for (const skill of snapshot.components.skills) {
    if (!skill.sourceSkillId || !skill.sourceHash) continue
    const now = current.get(skill.sourceSkillId)
    if (!now) {
      out.push(skill.key)
      continue
    }
    if ((await skillSourceHash(now.skill, now.resources)) !== skill.sourceHash) out.push(skill.key)
  }
  return out
}
