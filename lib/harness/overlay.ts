/**
 * Materialise a harness snapshot for one run (ADR-0237).
 *
 * A probe runs the candidate exactly as if it had been adopted, through the
 * normal resolver, without writing anything to the agent or the skill library:
 *
 * - an ephemeral agent: the base agent with the candidate's system prompt and
 *   harness sections, and no library skills of its own;
 * - an overlay of in-memory skills (with their resources) that the resolver
 *   joins to the run's skill set and registers in the run's load context.
 *
 * Every rollout of a run (base included) is materialised this way, so all of
 * them render skills identically and the only difference between them is the
 * harness under test.
 */

import type { Character, Skill, SkillResource } from "@cognia/agent-config-types"
import type { HarnessSkillV1, HarnessSnapshotV1 } from "@/types/harness/snapshot"

export interface HarnessOverlaySkill {
  skill: Skill
  resources: SkillResource[]
}

/** In-memory skills a single run should see. Input to `resolveSendOptions`. */
export interface HarnessRuntimeOverlay {
  snapshotId: string
  skills: HarnessOverlaySkill[]
}

const OVERLAY_PREFIX = "harness:"

/** Synthetic, collision-free id of a snapshot skill inside one run. */
export function harnessOverlaySkillId(snapshotId: string, key: string): string {
  return `${OVERLAY_PREFIX}${snapshotId}:${key}`
}

export function isHarnessOverlaySkillId(id: string): boolean {
  return id.startsWith(OVERLAY_PREFIX)
}

/** A snapshot skill as a library-shaped row that never touches the database. */
export function overlaySkillFromHarness(
  snapshotId: string,
  skill: HarnessSkillV1,
  now: number
): HarnessOverlaySkill {
  const id = harnessOverlaySkillId(snapshotId, skill.key)
  const row: Skill = {
    id,
    name: skill.name,
    slug: skill.key,
    description: skill.description,
    content: skill.content,
    ...(skill.allowedTools?.length ? { allowedTools: [...skill.allowedTools] } : {}),
    status: "enabled",
    source: "generated",
    kind: "markdown",
    category: "custom",
    tags: ["harness-evolution"],
    createdAt: now,
    updatedAt: now,
  }
  return {
    skill: row,
    resources: skill.resources.map((resource, index) => ({
      id: `${id}:r${index}`,
      skillId: id,
      kind: resource.kind,
      name: resource.path.split("/").pop() ?? resource.path,
      path: resource.path,
      content: resource.content,
      encoding: resource.encoding ?? "utf-8",
      size:
        (resource.encoding ?? "utf-8") === "utf-8"
          ? new TextEncoder().encode(resource.content).byteLength
          : Math.floor((resource.content.length * 3) / 4),
      inline: false,
      createdAt: now,
      updatedAt: now,
    })),
  }
}

export interface MaterializedHarnessRun {
  character: Character
  overlay: HarnessRuntimeOverlay
}

/**
 * The ephemeral agent and skill overlay for running `snapshot`. `base` is the
 * effective agent the snapshot was captured from: its execution configuration
 * (model, tools, permissions, sandbox, MCP servers) is kept as-is, because
 * evolution never edits it.
 */
export function materializeHarnessRun(
  snapshot: Pick<HarnessSnapshotV1, "id" | "components">,
  base: Character,
  now: number
): MaterializedHarnessRun {
  const { components } = snapshot
  const character: Character = {
    ...base,
    systemPrompt: components.systemPrompt,
    harness: {
      guardrails: components.guardrails,
      memory: components.memory,
      toolGuidance: components.toolGuidance,
      subagents: components.subagents.map((s) => ({ ...s })),
      toolRules: components.toolRules.map((r) => ({ ...r })),
    },
    // Every skill of the snapshot arrives through the overlay; the library
    // rows the base references must not also load, or a modified skill would
    // be present twice (old and new).
    skillIds: [],
  }
  delete character.variant
  return {
    character,
    overlay: {
      snapshotId: snapshot.id,
      skills: components.skills.map((s) => overlaySkillFromHarness(snapshot.id, s, now)),
    },
  }
}

/** Resources of the overlay, keyed by synthetic skill id, for the run's load context. */
export function overlayResourcesById(
  overlay: HarnessRuntimeOverlay | undefined
): Map<string, SkillResource[]> {
  return new Map((overlay?.skills ?? []).map((s) => [s.skill.id, s.resources]))
}
