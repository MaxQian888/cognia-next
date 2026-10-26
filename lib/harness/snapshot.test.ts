import type { Character, Skill, SkillResource } from "@cognia/agent-config-types"
import {
  buildHarnessSnapshot,
  canonicalHash,
  componentsFromCharacter,
  computeRuntimeFingerprint,
  diffHarness,
  driftedSkills,
  executionConfigFromCharacter,
  forkHarnessSnapshot,
  harnessContentHash,
  harnessSkillFromLibrary,
  isSnapshotStale,
  skillSourceHash,
  toJsonValue,
  type CapturedSkillInput,
} from "./snapshot"
import { makeComponents } from "./test-fixtures"

function librarySkill(id: string, slug: string, content = "Do the thing."): Skill {
  return {
    id,
    name: slug,
    slug,
    description: `${slug} skill`,
    content,
    status: "enabled",
    source: "custom",
    kind: "markdown",
    category: "custom",
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  } as Skill
}

function resource(skillId: string, path: string, kind: SkillResource["kind"]): SkillResource {
  return {
    id: `${skillId}:${path}`,
    skillId,
    kind,
    name: path.split("/").pop() ?? path,
    path,
    content: "print('hi')",
    encoding: "utf-8",
    size: 11,
    inline: false,
    createdAt: 1,
    updatedAt: 1,
  } as SkillResource
}

const character = {
  id: "agent-1",
  name: "Analyst",
  systemPrompt: "Be careful.",
  providerId: "anthropic",
  model: "claude-x",
  permissionMode: "default",
  allowedTools: ["Write", "Read"],
  mcpServerIds: ["b", "a"],
  harness: { guardrails: "No guessing.", toolRules: [] },
} as unknown as Character

describe("hashing", () => {
  it("is independent of key order and drops undefined", async () => {
    expect(await canonicalHash({ a: 1, b: { c: 2, d: undefined } })).toBe(
      await canonicalHash({ b: { c: 2 }, a: 1 })
    )
    expect(toJsonValue({ a: undefined, b: 1 })).toEqual({ b: 1 })
  })

  it("changes with any resource or description change", async () => {
    const skill = librarySkill("s1", "report")
    const a = await skillSourceHash(skill, [resource("s1", "scripts/a.py", "script")])
    const b = await skillSourceHash(skill, [resource("s1", "scripts/b.py", "script")])
    const c = await skillSourceHash({ ...skill, description: "other" }, [])
    expect(new Set([a, b, c]).size).toBe(3)
  })
})

describe("capture", () => {
  it("keeps editable resources and the source identity of a library skill", async () => {
    const skill = await harnessSkillFromLibrary({
      skill: librarySkill("s1", "report"),
      resources: [
        resource("s1", "scripts/run.py", "script"),
        resource("s1", "references/notes.md", "reference"),
        resource("s1", "SKILL.md", "other" as SkillResource["kind"]),
      ],
    })
    expect(skill.key).toBe("report")
    expect(skill.sourceSkillId).toBe("s1")
    expect(skill.sourceHash).toMatch(/^[0-9a-f]{64}$/)
    expect(skill.resources.map((r) => r.path)).toEqual(["references/notes.md", "scripts/run.py"])
  })

  it("reads components from an agent and suffixes colliding skill keys", async () => {
    const components = await componentsFromCharacter(character, [
      { skill: librarySkill("s1", "report"), resources: [] },
      { skill: librarySkill("s2", "report"), resources: [] },
    ])
    expect(components.systemPrompt).toBe("Be careful.")
    expect(components.guardrails).toBe("No guessing.")
    expect(components.memory).toBe("")
    expect(components.skills.map((s) => s.key)).toEqual(["report", "report-2"])
  })

  it("captures the execution configuration sorted, without undefined fields", () => {
    expect(executionConfigFromCharacter(character)).toEqual({
      providerId: "anthropic",
      model: "claude-x",
      permissionMode: "default",
      allowedTools: ["Read", "Write"],
      mcpServerIds: ["a", "b"],
    })
  })

  it("fingerprints the runtime and notices drift", async () => {
    const a = await computeRuntimeFingerprint({
      appVersion: "1.0.0",
      model: "m",
      enabledMcpServerIds: ["x", "y"],
    })
    const b = await computeRuntimeFingerprint({
      appVersion: "1.0.0",
      model: "m",
      enabledMcpServerIds: ["y", "x"],
    })
    const c = await computeRuntimeFingerprint({ appVersion: "1.0.1", model: "m" })
    expect(a).toMatch(/^hrf1-[0-9a-f]{32}$/)
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(isSnapshotStale({ runtimeFingerprint: a }, c)).toBe(true)
    expect(isSnapshotStale({ runtimeFingerprint: a }, b)).toBe(false)
  })
})

describe("snapshots", () => {
  const components = makeComponents()
  const execution = { model: "m" }

  it("is content-addressed and forks without touching the parent", async () => {
    const parent = await buildHarnessSnapshot({
      id: "snap-1",
      characterId: "agent-1",
      characterName: "Analyst",
      scope: "session",
      components,
      execution,
      runtimeFingerprint: "hrf1-x",
      origin: { kind: "captured" },
      createdAt: 1,
    })
    expect(parent.contentHash).toBe(await harnessContentHash(components, execution))
    expect(parent).not.toHaveProperty("parentId")
    const child = await forkHarnessSnapshot(parent, {
      id: "snap-2",
      components: { ...components, memory: "new fact" },
      origin: { kind: "candidate", runId: "run-1", label: "dom1" },
      createdAt: 2,
    })
    expect(child.parentId).toBe("snap-1")
    expect(child.scope).toBe("session")
    expect(child.contentHash).not.toBe(parent.contentHash)
    expect(parent.components.memory).toBe(components.memory)
    const same = await forkHarnessSnapshot(parent, {
      id: "snap-3",
      components,
      origin: { kind: "restored" },
      createdAt: 3,
    })
    expect(same.contentHash).toBe(parent.contentHash)
  })

  it("diffs at component level with the always-on delta", () => {
    const after = {
      ...components,
      memory: `${components.memory}\nOne more fact.`,
      skills: [],
    }
    const diff = diffHarness({ components, execution }, { components: after, execution })
    expect(diff.components.sort()).toEqual(["memory", "scripts", "skills"])
    expect(diff.changes).toEqual(
      expect.arrayContaining([
        { component: "memory", path: "memory.md", change: "modified" },
        { component: "skills", path: "skills/csv-report/SKILL.md", change: "removed" },
        { component: "scripts", path: "skills/csv-report/scripts/summarize.py", change: "removed" },
      ])
    )
    expect(diff.alwaysOnCharDelta).toBe("\nOne more fact.".length)
    expect(diff.executionChanged).toBe(false)
    expect(
      diffHarness({ components, execution }, { components, execution: { model: "other" } })
        .executionChanged
    ).toBe(true)
  })

  it("reports library skills that drifted since capture", async () => {
    const skill = librarySkill("s1", "report")
    const captured = await harnessSkillFromLibrary({ skill, resources: [] })
    const snapshot = { components: { ...components, skills: [captured] } }
    const unchanged = new Map<string, CapturedSkillInput>([["s1", { skill, resources: [] }]])
    expect(await driftedSkills(snapshot, unchanged)).toEqual([])
    const edited = new Map<string, CapturedSkillInput>([
      ["s1", { skill: { ...skill, content: "Changed." }, resources: [] }],
    ])
    expect(await driftedSkills(snapshot, edited)).toEqual(["report"])
    expect(await driftedSkills(snapshot, new Map())).toEqual(["report"])
  })
})
