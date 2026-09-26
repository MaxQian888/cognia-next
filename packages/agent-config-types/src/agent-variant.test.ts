import {
  CHARACTER_ROW_FIELDS,
  applyVariantOverlay,
  diffVariantOwnFields,
  isCharacterProfileField,
  materializeVariantProfile,
  sameProfileValue,
} from "./agent-variant"
import type { Character } from "./index"

function agent(fields: Partial<Character>): Character {
  return {
    id: "a",
    name: "Agent",
    avatarColor: "oklch(0.7 0 0)",
    systemPrompt: "",
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  } as Character
}

const base = agent({
  id: "base",
  name: "Reviewer",
  description: "Reviews code",
  systemPrompt: "Review carefully.",
  model: "sonnet",
  allowedTools: ["Read", "Grep"],
  skillIds: ["style"],
  sourcePluginId: "acme",
})

describe("isCharacterProfileField", () => {
  it("separates row fields from profile fields", () => {
    for (const field of CHARACTER_ROW_FIELDS) expect(isCharacterProfileField(field)).toBe(false)
    expect(isCharacterProfileField("systemPrompt")).toBe(true)
    expect(isCharacterProfileField("allowedTools")).toBe(true)
  })
})

describe("applyVariantOverlay", () => {
  it("inherits every profile field the variant does not own", () => {
    const variant = agent({
      id: "v",
      name: "Reviewer (strict)",
      systemPrompt: "stale snapshot",
      model: "opus",
      variant: { baseId: "base", ownFields: ["model"] },
    })
    const effective = applyVariantOverlay(variant, base)
    expect(effective).toMatchObject({
      id: "v",
      name: "Reviewer (strict)",
      systemPrompt: "Review carefully.",
      model: "opus",
      allowedTools: ["Read", "Grep"],
      skillIds: ["style"],
      variant: { baseId: "base", ownFields: ["model"] },
    })
  })

  it("never takes row fields from the base", () => {
    const variant = agent({ id: "v", name: "Mine", variant: { baseId: "base", ownFields: [] } })
    const effective = applyVariantOverlay(variant, base)
    expect(effective.description).toBeUndefined()
    expect(effective.sourcePluginId).toBeUndefined()
    expect(effective.name).toBe("Mine")
  })

  it("lets an owned but unset field clear the base's value", () => {
    const variant = agent({
      id: "v",
      variant: { baseId: "base", ownFields: ["allowedTools"] },
    })
    expect(applyVariantOverlay(variant, base).allowedTools).toBeUndefined()
  })
})

describe("sameProfileValue", () => {
  it("compares nested JSON structurally and treats undefined as absent", () => {
    expect(sameProfileValue({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true)
    expect(sameProfileValue({ a: 1, b: undefined }, { a: 1 })).toBe(true)
    expect(sameProfileValue([1, 2], [2, 1])).toBe(false)
    expect(sameProfileValue([1], { 0: 1 })).toBe(false)
    expect(sameProfileValue(undefined, null)).toBe(false)
    expect(sameProfileValue("a", "b")).toBe(false)
  })
})

describe("diffVariantOwnFields", () => {
  it("owns exactly the fields that differ from the base, sorted", () => {
    const edited = { ...base, name: "Renamed", model: "opus", skillIds: ["style", "security"] }
    expect(diffVariantOwnFields(base, edited)).toEqual(["model", "skillIds"])
  })

  it("owns a field the edit cleared", () => {
    expect(diffVariantOwnFields(base, { ...base, allowedTools: undefined })).toEqual([
      "allowedTools",
    ])
  })

  it("owns a field the base leaves unset", () => {
    expect(diffVariantOwnFields(base, { ...base, outputStyle: "concise" })).toEqual(["outputStyle"])
  })

  it("returns to following the base when a field is edited back", () => {
    expect(diffVariantOwnFields(base, { ...base })).toEqual([])
  })
})

describe("materializeVariantProfile", () => {
  it("keeps set profile fields only", () => {
    expect(
      materializeVariantProfile(agent({ id: "v", model: "opus", allowedTools: undefined }))
    ).toEqual({ systemPrompt: "", model: "opus" })
  })
})
