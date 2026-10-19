/** @jest-environment jsdom */

import { createCharacter, getCharacter, resolveCharacterById } from "@/lib/db/characters"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { resourceKey } from "../resources"
import { characterPromptAdapter } from "./characters"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

async function builtIn(name = "Shipped", systemPrompt = "Shipped prompt.") {
  const character = await createCharacter({ name, systemPrompt })
  await getDb().characters.update(character.id, { isBuiltIn: true })
  return character
}

const keyOf = (id: string) => resourceKey("character", id)
const idOf = (key: string) => key.slice("character:".length)

describe("characterPromptAdapter", () => {
  it("lists user agents as editable and shipped ones as custom-copy", async () => {
    const shipped = await builtIn()
    const mine = await createCharacter({ name: "Mine", systemPrompt: "Mine.", description: "d" })
    const listed = await characterPromptAdapter.list({})
    expect(listed.find((entry) => entry.key === keyOf(mine.id))).toMatchObject({
      kind: "role",
      operation: "legacy-replace",
      builtIn: false,
      edit: "source",
      modified: false,
      detail: "d",
      ownerSection: "characters",
    })
    expect(listed.find((entry) => entry.key === keyOf(shipped.id))).toMatchObject({
      builtIn: true,
      edit: "custom-copy",
    })
  })

  it("saves a user agent in place and refuses a built-in", async () => {
    const shipped = await builtIn()
    const mine = await createCharacter({ name: "Mine", systemPrompt: "Old." })
    const saved = await characterPromptAdapter.save!(keyOf(mine.id), "New.", undefined, {})
    expect(saved).toEqual({ key: keyOf(mine.id), text: "New." })
    await expect(
      characterPromptAdapter.save!(keyOf(shipped.id), "x", undefined, {})
    ).rejects.toThrow("shipped")
    expect((await getCharacter(shipped.id))?.systemPrompt).toBe("Shipped prompt.")
  })

  it("edits a shipped agent through one variant that owns only its prompt", async () => {
    const shipped = await builtIn()
    const first = await characterPromptAdapter.saveCustom!(
      keyOf(shipped.id),
      "Custom.",
      {},
      {
        name: "Mine",
      }
    )
    const variant = await resolveCharacterById(idOf(first))
    expect(variant).toMatchObject({ name: "Mine", systemPrompt: "Custom." })
    expect(variant?.variant).toEqual({ baseId: shipped.id, ownFields: ["systemPrompt"] })

    // A second edit updates the same variant rather than creating another.
    const second = await characterPromptAdapter.saveCustom!(keyOf(shipped.id), "Again.", {})
    expect(second).toBe(first)
    expect((await resolveCharacterById(idOf(first)))?.systemPrompt).toBe("Again.")

    const doc = await characterPromptAdapter.read(keyOf(shipped.id), {})
    expect(doc).toMatchObject({
      readOnlyReason: "built-in",
      customKey: first,
      text: "Shipped prompt.",
    })
    const variantDoc = await characterPromptAdapter.read(first, {})
    expect(variantDoc).toEqual({ key: first, text: "Again.", baseText: "Shipped prompt." })
    const listed = await characterPromptAdapter.list({})
    expect(listed.find((entry) => entry.key === first)?.modified).toBe(true)
  })

  it("resets a variant's prompt to its base and leaves its other edits", async () => {
    const shipped = await builtIn()
    const key = await characterPromptAdapter.saveCustom!(
      keyOf(shipped.id),
      "Custom.",
      {},
      {
        name: "Renamed",
      }
    )
    await characterPromptAdapter.reset!(key, {})
    const variant = await resolveCharacterById(idOf(key))
    expect(variant?.systemPrompt).toBe("Shipped prompt.")
    expect(variant?.name).toBe("Renamed")
    expect(variant?.variant?.ownFields).not.toContain("systemPrompt")
  })

  it("refuses to reset an agent that is not a variant", async () => {
    const mine = await createCharacter({ name: "Mine", systemPrompt: "x" })
    await expect(characterPromptAdapter.reset!(keyOf(mine.id), {})).rejects.toThrow("not a variant")
  })

  it("treats the support agent as immutable", async () => {
    await getDb().characters.put({
      id: "char_builtin_support",
      name: "Support",
      avatarColor: "red",
      systemPrompt: "Support.",
      isBuiltIn: true,
      createdAt: 1,
      updatedAt: 1,
    })
    expect(
      (await characterPromptAdapter.read(keyOf("char_builtin_support"), {}))?.readOnlyReason
    ).toBe("immutable")
  })

  it("reads a missing agent as absent and rejects foreign keys", async () => {
    expect(await characterPromptAdapter.read(keyOf("missing"), {})).toBeUndefined()
    await expect(characterPromptAdapter.read("skill:x", {})).rejects.toThrow("not a character")
  })
})
