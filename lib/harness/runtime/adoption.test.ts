import type { Character, Skill } from "@cognia/agent-config-types"
import type { EvalConfigurationApplyRow } from "@/lib/db/eval-lab"
import type { HarnessEvolutionRun } from "@/types/harness/evolution"
import type { HarnessSnapshotV1 } from "@/types/harness/snapshot"
import { makeComponents, makeRun, makeRunConfig, makeSkill } from "../test-fixtures"
import {
  HarnessAdoptionError,
  adoptHarness,
  harnessProjection,
  resolveSnapshotSkillIds,
  rollbackHarnessAdoption,
  type AdoptionDeps,
} from "./adoption"

const baseComponents = makeComponents({
  skills: [makeSkill({ sourceSkillId: "lib-csv", sourceHash: "h" })],
})
const base: HarnessSnapshotV1 = {
  schemaVersion: 1,
  id: "snap-base",
  contentHash: "hash-base",
  characterId: "agent-1",
  characterName: "Analyst",
  scope: "task",
  components: baseComponents,
  execution: {},
  runtimeFingerprint: "hrf1-a",
  origin: { kind: "captured" },
  createdAt: 1,
}
const chosen: HarnessSnapshotV1 = {
  ...base,
  id: "snap-agg1",
  contentHash: "hash-agg1",
  origin: { kind: "composed", runId: "run-1", label: "agg1" },
  components: {
    ...baseComponents,
    memory: "Reports go in report.md.\nCSV files may use ; separators.",
    skills: [
      ...baseComponents.skills,
      makeSkill({ key: "csv-check", name: "csv-check", content: "Check the header first." }),
    ],
  },
}

interface World {
  characters: Map<string, Character>
  applies: Map<string, EvalConfigurationApplyRow>
  sessions: Map<string, string | undefined>
  workspaceDefault: Map<string, string | null>
  skills: Skill[]
  runs: HarnessEvolutionRun[]
  governance: string[]
}

function world(): World {
  return {
    characters: new Map([
      [
        "agent-1",
        {
          id: "agent-1",
          name: "Analyst",
          avatarColor: "x",
          systemPrompt: baseComponents.systemPrompt,
          skillIds: ["builtin-x", "lib-csv"],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    ]),
    applies: new Map(),
    sessions: new Map([["sess-1", "agent-1"]]),
    workspaceDefault: new Map([["proj-1", "other-agent"]]),
    skills: [],
    runs: [],
    governance: [],
  }
}

function deps(w: World): AdoptionDeps {
  let n = 0
  return {
    resolveCharacter: async (id) => w.characters.get(id),
    updateCharacter: async (id, patch) => {
      const current = w.characters.get(id)
      if (!current) throw new Error("missing")
      w.characters.set(id, { ...current, ...patch })
    },
    createCharacterVariant: async (baseId, name) => {
      const row = {
        ...(w.characters.get(baseId) as Character),
        id: `variant-${++n}`,
        name,
        variant: { baseId, ownFields: [] },
      }
      w.characters.set(row.id, row)
      return row
    },
    listRuns: async () => w.runs,
    upsertSkill: async ({ draft, canonicalId }) => {
      const existing = w.skills.find((s) => s.canonicalId === canonicalId)
      if (existing) return { skill: existing }
      const skill = { ...draft, id: `skill-${w.skills.length + 1}`, canonicalId } as Skill
      w.skills.push(skill)
      return { skill }
    },
    saveApply: async (r) => void w.applies.set(r.id, r),
    getApply: async (id) => w.applies.get(id),
    updateApply: async (id, patch) =>
      void w.applies.set(id, { ...(w.applies.get(id) as EvalConfigurationApplyRow), ...patch }),
    getSessionCharacterId: async (id) => w.sessions.get(id),
    switchSessionAgent: async (id, characterId) => void w.sessions.set(id, characterId),
    getWorkspaceDefaultAgent: async (id) => w.workspaceDefault.get(id),
    setWorkspaceDefaultAgent: async (id, characterId) =>
      void w.workspaceDefault.set(id, characterId),
    recordGovernance: async (input) => {
      w.governance.push(`adopt:${input.targetCharacterId}:${input.approvedBy}`)
      return `harness-adoption:${input.runId}`
    },
    recordRollbackGovernance: async (input) =>
      void w.governance.push(`rollback:${input.targetCharacterId}`),
    now: () => 1000,
    newId: () => `apply-${Math.random().toString(36).slice(2, 8)}`,
  }
}

function adoptingRun(
  scope: HarnessEvolutionRun["config"]["scope"],
  over: Partial<HarnessEvolutionRun> = {}
) {
  return makeRun({
    sessionId: "sess-1",
    projectId: "proj-1",
    baseSnapshotId: base.id,
    config: makeRunConfig({ scope }),
    decision: {
      outcome: "adopt",
      reason: "agg1 dominated",
      chosenLabel: "agg1",
      chosenSnapshotId: chosen.id,
      risk: "medium",
      requiresApproval: true,
    },
    ...over,
  })
}

const adoptInput = (run: HarnessEvolutionRun) => ({
  run,
  chosen,
  base,
  carriedSkillIds: ["builtin-x"],
  approvedBy: "person" as const,
  currentContentHash: base.contentHash,
})

describe("resolveSnapshotSkillIds", () => {
  it("keeps unchanged library skills and forks new or edited ones by content", async () => {
    const w = world()
    const ids = await resolveSnapshotSkillIds(chosen, base, "agent-1", deps(w))
    expect(ids[0]).toBe("lib-csv")
    expect(w.skills[0]).toMatchObject({
      slug: "csv-check",
      tags: ["harness-evolution"],
      source: "generated",
    })
    expect(w.skills[0].canonicalId).toMatch(/^harness:agent-1:csv-check:[0-9a-f]{12}$/)
    const edited = {
      ...chosen,
      components: {
        ...chosen.components,
        skills: [{ ...baseComponents.skills[0], content: "changed" }],
      },
    }
    const [forked] = await resolveSnapshotSkillIds(edited, base, "agent-1", deps(w))
    expect(forked).not.toBe("lib-csv")
    // Same content again: the same fork row.
    expect(await resolveSnapshotSkillIds(edited, base, "agent-1", deps(w))).toEqual([forked])
  })
})

describe("adoptHarness", () => {
  it("does nothing outside the run at task scope", async () => {
    const w = world()
    const adoption = await adoptHarness(adoptInput(adoptingRun("task")), deps(w))
    expect(adoption).toEqual({ scope: "task", approvedBy: "person", adoptedAt: 1000 })
    expect(w.applies.size).toBe(0)
  })

  it("updates the agent itself at global scope and rolls back", async () => {
    const w = world()
    const d = deps(w)
    const run = adoptingRun("global")
    const adoption = await adoptHarness(adoptInput(run), d)
    const agent = w.characters.get("agent-1") as Character
    expect(agent.harness?.memory).toContain("separators")
    expect(agent.harness?.adoptedSnapshotId).toBe("snap-agg1")
    expect(agent.skillIds).toEqual(["builtin-x", "lib-csv", "skill-1"])
    expect(adoption).toMatchObject({
      scope: "global",
      targetCharacterId: "agent-1",
      decisionId: "harness-adoption:run-1",
    })
    expect(w.governance).toEqual(["adopt:agent-1:person"])

    const rolled = await rollbackHarnessAdoption({ ...run, adoption }, d)
    expect(rolled.rolledBackAt).toBe(1000)
    expect(harnessProjection(w.characters.get("agent-1") as Character)).toEqual({
      systemPrompt: baseComponents.systemPrompt,
      harness: null,
      skillIds: ["builtin-x", "lib-csv"],
    })
    expect(w.governance).toEqual(["adopt:agent-1:person", "rollback:agent-1"])
    await expect(rollbackHarnessAdoption({ ...run, adoption: rolled }, d)).rejects.toMatchObject({
      code: "already-rolled-back",
    })
  })

  it("refuses a rollback after unrelated edits", async () => {
    const w = world()
    const d = deps(w)
    const run = adoptingRun("global")
    const adoption = await adoptHarness(adoptInput(run), d)
    await d.updateCharacter("agent-1", { systemPrompt: "edited by hand" })
    await expect(rollbackHarnessAdoption({ ...run, adoption }, d)).rejects.toThrow(/changed/)
  })

  it("creates an evolved variant at workspace scope, sets the default on request and restores it", async () => {
    const w = world()
    const d = deps(w)
    const run = adoptingRun("workspace")
    const adoption = await adoptHarness({ ...adoptInput(run), setAsWorkspaceDefault: true }, d)
    expect(adoption).toMatchObject({
      targetCharacterId: "variant-1",
      variantCreated: true,
      setAsWorkspaceDefault: true,
      previousWorkspaceDefaultId: "other-agent",
    })
    expect(w.characters.get("variant-1")?.name).toBe("Analyst · evolved")
    expect(w.characters.get("agent-1")?.harness).toBeUndefined()
    expect(w.workspaceDefault.get("proj-1")).toBe("variant-1")

    // A later adoption reuses the same variant.
    w.runs = [{ ...run, adoption }]
    const second = await adoptHarness(
      adoptInput(
        adoptingRun("workspace", { id: "run-2", decision: { ...run.decision!, reason: "again" } })
      ),
      d
    )
    // The same variant already carries this harness: nothing is written again.
    expect(second).toMatchObject({ targetCharacterId: "variant-1" })
    expect(second.applyId).toBeUndefined()
    expect(second.variantCreated).toBeUndefined()

    await rollbackHarnessAdoption({ ...run, adoption }, d)
    expect(w.workspaceDefault.get("proj-1")).toBe("other-agent")
  })

  it("switches the conversation at session scope and back on rollback", async () => {
    const w = world()
    const d = deps(w)
    const run = adoptingRun("session")
    const adoption = await adoptHarness(adoptInput(run), d)
    expect(w.sessions.get("sess-1")).toBe("variant-1")
    expect(adoption).toMatchObject({ sessionId: "sess-1", previousCharacterId: "agent-1" })
    await rollbackHarnessAdoption({ ...run, adoption }, d)
    expect(w.sessions.get("sess-1")).toBe("agent-1")
  })

  it("refuses without a decision, over a changed agent, or without the session or workspace", async () => {
    const w = world()
    const d = deps(w)
    await expect(
      adoptHarness({ ...adoptInput(adoptingRun("global")), chosen: { ...chosen, id: "other" } }, d)
    ).rejects.toMatchObject({ code: "no-decision" })
    await expect(
      adoptHarness({ ...adoptInput(adoptingRun("global")), currentContentHash: "drifted" }, d)
    ).rejects.toMatchObject({ code: "agent-changed" })
    await expect(
      adoptHarness(adoptInput(adoptingRun("session", { sessionId: undefined })), d)
    ).rejects.toBeInstanceOf(HarnessAdoptionError)
    w.sessions.delete("sess-1")
    await expect(adoptHarness(adoptInput(adoptingRun("session")), d)).rejects.toMatchObject({
      code: "no-session",
    })
    await expect(
      adoptHarness(adoptInput(adoptingRun("workspace", { projectId: undefined })), d)
    ).rejects.toMatchObject({ code: "no-workspace" })
    w.characters.clear()
    await expect(adoptHarness(adoptInput(adoptingRun("global")), d)).rejects.toMatchObject({
      code: "agent-not-found",
    })
    await expect(rollbackHarnessAdoption(adoptingRun("global"), d)).rejects.toMatchObject({
      code: "not-adopted",
    })
  })
})
