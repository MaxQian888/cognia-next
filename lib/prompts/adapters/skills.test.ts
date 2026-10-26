/** @jest-environment jsdom */

import { getDb } from "@/lib/db/schema"
import { createSkill, getSkill } from "@/lib/db/skills"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { resourceKey } from "../resources"
import { skillPromptAdapter } from "./skills"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

async function builtInSkill() {
  const skill = await createSkill({ name: "Shipped", content: "Shipped body." })
  await getDb().skills.update(skill.id, { isBuiltIn: true })
  return skill
}

describe("skillPromptAdapter", () => {
  it("lists Skills by name as procedures, built-ins as custom-copy", async () => {
    const shipped = await builtInSkill()
    const mine = await createSkill({ name: "Alpha", content: "Mine.", description: "Does a" })
    const listed = await skillPromptAdapter.list({})
    const names = listed.map((entry) => entry.name!)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
    expect(listed.find((entry) => entry.key === resourceKey("skill", mine.id))).toMatchObject({
      key: resourceKey("skill", mine.id),
      kind: "procedure",
      operation: "activate-procedure",
      edit: "source",
      detail: "Does a",
      ownerSection: "skills",
    })
    expect(listed.find((entry) => entry.key === resourceKey("skill", shipped.id))).toMatchObject({
      builtIn: true,
      edit: "custom-copy",
    })
  })

  it("saves a user Skill's body and refuses a built-in", async () => {
    const shipped = await builtInSkill()
    const mine = await createSkill({ name: "Mine", content: "Old." })
    expect(
      await skillPromptAdapter.save!(resourceKey("skill", mine.id), "New.", undefined, {})
    ).toEqual({
      key: resourceKey("skill", mine.id),
      text: "New.",
    })
    await expect(
      skillPromptAdapter.save!(resourceKey("skill", shipped.id), "x", undefined, {})
    ).rejects.toThrow("built in")
    expect((await getSkill(shipped.id))?.content).toBe("Shipped body.")
    expect(
      (await skillPromptAdapter.read(resourceKey("skill", shipped.id), {}))?.readOnlyReason
    ).toBe("built-in")
  })

  it("copies a built-in into a user Skill carrying the edited body", async () => {
    const shipped = await builtInSkill()
    const copyKey = await skillPromptAdapter.saveCustom!(
      resourceKey("skill", shipped.id),
      "Edited.",
      {},
      { name: "My skill" }
    )
    const copy = await getSkill(copyKey.slice("skill:".length))
    expect(copy).toMatchObject({ name: "My skill", content: "Edited.", isBuiltIn: false })
    expect((await getSkill(shipped.id))?.content).toBe("Shipped body.")
  })

  it("reads a missing Skill as absent and rejects foreign keys", async () => {
    expect(await skillPromptAdapter.read(resourceKey("skill", "nope"), {})).toBeUndefined()
    await expect(skillPromptAdapter.read("preset:x", {})).rejects.toThrow("not a skill resource")
    await expect(
      skillPromptAdapter.save!(resourceKey("skill", "nope"), "x", undefined, {})
    ).rejects.toThrow("not found")
  })
})
