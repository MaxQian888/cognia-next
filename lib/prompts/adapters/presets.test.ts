/** @jest-environment jsdom */

import { createPreset, getPreset, listPresets, seedBuiltInPresets } from "@/lib/db/prompt-presets"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { BUILT_IN_PRESET_IDS } from "@/lib/presets/built-ins"
import { resourceKey } from "../resources"
import { presetPromptAdapter } from "./presets"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const builtInId = [...BUILT_IN_PRESET_IDS][0]

describe("presetPromptAdapter", () => {
  it("lists built-ins as custom-copy and the user's presets as editable in place", async () => {
    await seedBuiltInPresets()
    const mine = await createPreset({ name: "Mine", content: "Be terse." })
    const listed = await presetPromptAdapter.list({})
    expect(listed.find((entry) => entry.key === resourceKey("preset", builtInId))).toMatchObject({
      builtIn: true,
      edit: "custom-copy",
      kind: "role",
      operation: "legacy-replace",
      ownerSection: "presets",
    })
    expect(listed.find((entry) => entry.key === resourceKey("preset", mine.id))).toMatchObject({
      name: "Mine",
      builtIn: false,
      edit: "source",
    })
  })

  it("reads a built-in as read-only and refuses to save it in place", async () => {
    await seedBuiltInPresets()
    const key = resourceKey("preset", builtInId)
    const doc = await presetPromptAdapter.read(key, {})
    expect(doc?.readOnlyReason).toBe("built-in")
    await expect(presetPromptAdapter.save!(key, "x", undefined, {})).rejects.toThrow()
    expect((await getPreset(builtInId))?.content).toBe(doc?.text)
  })

  it("saves a user preset through its owner", async () => {
    const mine = await createPreset({ name: "Mine", content: "Be terse." })
    const key = resourceKey("preset", mine.id)
    const saved = await presetPromptAdapter.save!(key, "Be brief.", undefined, {})
    expect(saved).toEqual({ key, text: "Be brief." })
    expect((await getPreset(mine.id))?.content).toBe("Be brief.")
  })

  it("copies a built-in into a named custom preset carrying the edited text", async () => {
    await seedBuiltInPresets()
    const before = (await listPresets()).length
    const copyKey = await presetPromptAdapter.saveCustom!(
      resourceKey("preset", builtInId),
      "Edited copy.",
      {},
      { name: "  My copy  " }
    )
    const copyId = copyKey.slice("preset:".length)
    expect(await getPreset(copyId)).toMatchObject({
      name: "My copy",
      content: "Edited copy.",
      isBuiltIn: false,
    })
    expect((await listPresets()).length).toBe(before + 1)
  })

  it("makes a preset the default without touching its text", async () => {
    const mine = await createPreset({ name: "Mine", content: "Be terse." })
    await presetPromptAdapter.makeDefault!(resourceKey("preset", mine.id), {})
    expect(await getPreset(mine.id)).toMatchObject({ isDefault: true, content: "Be terse." })
  })

  it("rejects a key of another source and reads a missing preset as absent", async () => {
    await expect(presetPromptAdapter.read("skill:x", {})).rejects.toThrow("not a preset resource")
    expect(await presetPromptAdapter.read(resourceKey("preset", "missing"), {})).toBeUndefined()
  })
})
