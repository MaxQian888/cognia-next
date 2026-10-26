import type { Character, Skill } from "@cognia/agent-config-types"
import type { EvalConfigurationApplyRow } from "@/lib/db/eval-lab"
import { rollbackEvalRecommendation } from "@/lib/ai/eval/recommendation-application"
import type { HarnessSnapshotV1 } from "@/types/harness/snapshot"
import { makeComponents, makeSkill } from "../test-fixtures"
import { harnessApplicationDeps, type AdoptionDeps } from "./adoption"
import type { CapturedHarness } from "./capture"
import {
  HarnessRestoreError,
  previewHarnessRestore,
  restoreHarnessVersion,
  type RestoreDeps,
} from "./restore"

const currentComponents = makeComponents({
  systemPrompt: "Write the report. Be brief.",
  toolRules: [{ id: "cap", kind: "call-cap", tool: "Bash", maxCalls: 3, reason: "Loops." }],
  skills: [makeSkill({ sourceSkillId: "lib-csv", sourceHash: "h" })],
})
const current: HarnessSnapshotV1 = {
  schemaVersion: 1,
  id: "snap-now",
  contentHash: "hash-now",
  characterId: "agent-1",
  characterName: "Analyst",
  scope: "global",
  components: currentComponents,
  execution: { model: "m-2" },
  runtimeFingerprint: "hrf1-now",
  origin: { kind: "captured" },
  createdAt: 50,
}
const older: HarnessSnapshotV1 = {
  ...current,
  id: "snap-old",
  contentHash: "hash-old",
  execution: { model: "m-1" },
  origin: { kind: "adopted", runId: "run-0", label: "agg1" },
  components: {
    ...currentComponents,
    systemPrompt: "Write the report.",
    toolRules: [],
    skills: [
      ...currentComponents.skills,
      makeSkill({ key: "csv-check", name: "csv-check", content: "Check the header first." }),
    ],
  },
  createdAt: 10,
}

function setup() {
  const characters = new Map<string, Character>([
    [
      "agent-1",
      {
        id: "agent-1",
        name: "Analyst",
        avatarColor: "x",
        systemPrompt: currentComponents.systemPrompt,
        skillIds: ["builtin-x", "lib-csv"],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  ])
  const applies = new Map<string, EvalConfigurationApplyRow>()
  const snapshots = new Map([
    [current.id, current],
    [older.id, older],
    ["snap-foreign", { ...older, id: "snap-foreign", characterId: "agent-2" }],
  ])
  const skills: Skill[] = []
  const governance: unknown[] = []
  let ids = 0
  const adoption = {
    resolveCharacter: async (id: string) => characters.get(id),
    updateCharacter: async (id: string, patch: Partial<Character>) =>
      void characters.set(id, { ...(characters.get(id) as Character), ...patch }),
    upsertSkill: async ({ draft, canonicalId }: { draft: Skill; canonicalId: string }) => {
      const skill = { ...draft, id: `skill-${skills.length + 1}`, canonicalId } as Skill
      skills.push(skill)
      return { skill }
    },
    saveApply: async (r: EvalConfigurationApplyRow) => void applies.set(r.id, r),
    getApply: async (id: string) => applies.get(id),
    updateApply: async (id: string, patch: Partial<EvalConfigurationApplyRow>) =>
      void applies.set(id, { ...(applies.get(id) as EvalConfigurationApplyRow), ...patch }),
    now: () => 500,
    newId: () => `id-${++ids}`,
  } as unknown as AdoptionDeps
  const deps: RestoreDeps = {
    adoption,
    capture: async () =>
      ({ snapshot: current, carriedSkillIds: ["builtin-x"] }) as unknown as CapturedHarness,
    getSnapshot: async (id) => snapshots.get(id),
    putSnapshot: async (s) => void snapshots.set(s.id, s),
    recordGovernance: async (input) => {
      governance.push(input)
      return `harness-restore:${input.restoredSnapshotId}`
    },
  }
  return { deps, characters, applies, snapshots, skills, governance }
}

describe("previewHarnessRestore", () => {
  it("rates going back like an adoption, against today's harness", async () => {
    const { deps } = setup()
    const preview = await previewHarnessRestore("agent-1", "snap-old", deps)
    expect(preview.current.id).toBe("snap-now")
    expect(preview.unchanged).toBe(false)
    // Dropping a tool rule is high risk; the execution difference is ignored
    // because a restore never touches it.
    expect(preview.risk.risk).toBe("high")
    expect(preview.risk.reasons).toContain("tool rule cap removed")
    expect(preview.risk.reasons).not.toContain("the execution configuration changed")
    expect(preview.carriedSkillIds).toEqual(["builtin-x"])
  })

  it("refuses versions that are gone or another agent's", async () => {
    const { deps } = setup()
    await expect(previewHarnessRestore("agent-1", "nope", deps)).rejects.toMatchObject({
      code: "not-found",
    })
    await expect(previewHarnessRestore("agent-1", "snap-foreign", deps)).rejects.toMatchObject({
      code: "other-agent",
    })
  })
})

describe("restoreHarnessVersion", () => {
  it("writes the version as a new restored snapshot, undoably, and records the decision", async () => {
    const w = setup()
    const result = await restoreHarnessVersion(
      { characterId: "agent-1", snapshotId: "snap-old", expectedContentHash: "hash-now" },
      w.deps
    )
    expect(result.restored).toMatchObject({
      parentId: "snap-now",
      origin: { kind: "restored", label: "agg1" },
      // The current model stays: a restore cannot change execution.
      execution: { model: "m-2" },
      components: older.components,
    })
    expect(w.snapshots.get(result.restored.id)).toBe(result.restored)
    const agent = w.characters.get("agent-1") as Character
    expect(agent.systemPrompt).toBe("Write the report.")
    expect(agent.harness).toMatchObject({ toolRules: [], adoptedSnapshotId: result.restored.id })
    // Carried and unchanged library skills keep their ids; the new one is forked.
    expect(agent.skillIds).toEqual(["builtin-x", "lib-csv", "skill-1"])
    expect(w.governance).toEqual([
      expect.objectContaining({
        sourceSnapshotId: "snap-old",
        restoredSnapshotId: result.restored.id,
        risk: "high",
        applyId: result.applyId,
      }),
    ])

    await rollbackEvalRecommendation(
      result.applyId as string,
      harnessApplicationDeps(w.deps.adoption)
    )
    const undone = w.characters.get("agent-1") as Character
    expect(undone.systemPrompt).toBe(currentComponents.systemPrompt)
    expect(undone.skillIds).toEqual(["builtin-x", "lib-csv"])
  })

  it("refuses when the agent moved since the review, or already has the version", async () => {
    const w = setup()
    await expect(
      restoreHarnessVersion(
        { characterId: "agent-1", snapshotId: "snap-old", expectedContentHash: "stale" },
        w.deps
      )
    ).rejects.toBeInstanceOf(HarnessRestoreError)
    await expect(
      restoreHarnessVersion(
        { characterId: "agent-1", snapshotId: "snap-now", expectedContentHash: "hash-now" },
        w.deps
      )
    ).rejects.toMatchObject({ code: "unchanged" })
    expect(w.applies.size).toBe(0)
  })
})
