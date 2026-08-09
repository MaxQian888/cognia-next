import { getDb } from "./schema"
import { createSkill } from "./skills"
import { createResource, getResource } from "./skill-resources"
import { saveSkillWorkspace } from "./skill-workspace"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().skills.clear()
  await getDb().skillResources.clear()
})
afterAll(dbFixture.dispose)

describe("saveSkillWorkspace", () => {
  it("commits main and resource drafts in one transaction", async () => {
    const skill = await createSkill({ name: "Demo", content: "old" })
    const resource = await createResource({
      skillId: skill.id,
      kind: "script",
      name: "run.sh",
      path: "scripts/run.sh",
      content: "old resource",
    })

    const result = await saveSkillWorkspace({
      skillId: skill.id,
      files: [
        { id: "main", kind: "main", baseline: "old", content: "new" },
        {
          id: resource.id,
          kind: "resource",
          resourceId: resource.id,
          baseline: "old resource",
          content: "new resource",
        },
      ],
    })

    expect(result).toEqual({ status: "saved", savedFileIds: ["main", resource.id] })
    expect((await getDb().skills.get(skill.id))?.content).toBe("new")
    expect((await getResource(resource.id))?.content).toBe("new resource")
  })

  it("returns conflict without writing any file when a baseline is stale", async () => {
    const skill = await createSkill({ name: "Demo", content: "old" })
    const resource = await createResource({
      skillId: skill.id,
      kind: "reference",
      name: "note.md",
      path: "references/note.md",
      content: "changed elsewhere",
    })

    const result = await saveSkillWorkspace({
      skillId: skill.id,
      files: [
        { id: "main", kind: "main", baseline: "old", content: "new" },
        {
          id: resource.id,
          kind: "resource",
          resourceId: resource.id,
          baseline: "stale",
          content: "draft",
        },
      ],
    })

    expect(result.status).toBe("conflict")
    expect((await getDb().skills.get(skill.id))?.content).toBe("old")
    expect((await getResource(resource.id))?.content).toBe("changed elsewhere")
  })

  it("blocks an empty main body without discarding the draft", async () => {
    const skill = await createSkill({ name: "Demo", content: "old" })
    const result = await saveSkillWorkspace({
      skillId: skill.id,
      files: [{ id: "main", kind: "main", baseline: "old", content: "  " }],
    })

    expect(result.status).toBe("blocked")
    expect((await getDb().skills.get(skill.id))?.content).toBe("old")
  })

  it("saves Codex YAML and synchronizes its invocation policy", async () => {
    const skill = await createSkill({
      name: "Demo",
      content: "old",
      codexOpenAiYaml: "vendor:\n  keep: true\n",
    })
    const content = "policy:\n  allow_implicit_invocation: false\nvendor:\n  keep: true\n"
    const result = await saveSkillWorkspace({
      skillId: skill.id,
      files: [
        {
          id: "codex",
          kind: "codex",
          baseline: "vendor:\n  keep: true\n",
          content,
        },
      ],
    })

    expect(result).toEqual({ status: "saved", savedFileIds: ["codex"] })
    expect(await getDb().skills.get(skill.id)).toMatchObject({
      codexOpenAiYaml: content,
      invocationPolicy: "explicit",
    })
  })

  it("blocks malformed Codex YAML and keeps the last valid config", async () => {
    const skill = await createSkill({
      name: "Demo",
      content: "old",
      codexOpenAiYaml: "policy: {}\n",
    })
    const result = await saveSkillWorkspace({
      skillId: skill.id,
      files: [
        {
          id: "codex",
          kind: "codex",
          baseline: "policy: {}\n",
          content: "policy: [broken",
        },
      ],
    })

    expect(result.status).toBe("blocked")
    expect((await getDb().skills.get(skill.id))?.codexOpenAiYaml).toBe("policy: {}\n")
  })
})
