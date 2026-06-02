import { generatePetSoul, parseSoulResponse, fallbackSoul } from "./generate-soul"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type { PetBones } from "@/types/pet"

function makeBones(overrides: Partial<PetBones> = {}): PetBones {
  return {
    species: "cat",
    rarity: "rare",
    stars: 3,
    eyes: "dot",
    hat: "none",
    shiny: false,
    bodyType: "round",
    palette: { primary: "#a", secondary: "#b", accent: "#c" },
    stats: { debugging: 1, patience: 2, chaos: 3, wisdom: 4, snark: 5 },
    ...overrides,
  }
}

function mockClient(reply: string): LlmClient {
  return { complete: jest.fn().mockResolvedValue(reply) } as unknown as LlmClient
}

describe("parseSoulResponse", () => {
  it("extracts name + personality from clean JSON", () => {
    expect(parseSoulResponse('{"name":"Boba","personality":"Sleepy and smug."}')).toEqual({
      name: "Boba",
      personality: "Sleepy and smug.",
    })
  })

  it("extracts JSON embedded in prose", () => {
    expect(parseSoulResponse('Sure! {"name":"Pip","personality":"Zoomy."} enjoy')).toEqual({
      name: "Pip",
      personality: "Zoomy.",
    })
  })

  it("returns null for malformed or incomplete output", () => {
    expect(parseSoulResponse("not json")).toBeNull()
    expect(parseSoulResponse('{"name":"x"}')).toBeNull()
    expect(parseSoulResponse('{"name":"","personality":"y"}')).toBeNull()
    expect(parseSoulResponse("")).toBeNull()
  })
})

describe("fallbackSoul", () => {
  it("is deterministic for the same bones and sets the hatch date", () => {
    const a = fallbackSoul(makeBones(), 1000)
    const b = fallbackSoul(makeBones(), 1000)
    expect(a).toEqual(b)
    expect(a.hatchDate).toBe(new Date(1000).toISOString())
    expect(a.name).toBeTruthy()
  })
})

describe("generatePetSoul", () => {
  it("uses the LLM reply when valid", async () => {
    const soul = await generatePetSoul(
      mockClient('{"name":"Nova","personality":"Curious."}'),
      makeBones(),
      { now: 2000 }
    )
    expect(soul).toEqual({
      name: "Nova",
      personality: "Curious.",
      hatchDate: new Date(2000).toISOString(),
    })
  })

  it("falls back when the client is null", async () => {
    const soul = await generatePetSoul(null, makeBones(), { now: 3000 })
    expect(soul.name).toBeTruthy()
    expect(soul.hatchDate).toBe(new Date(3000).toISOString())
  })

  it("falls back when the LLM throws", async () => {
    const client = {
      complete: jest.fn().mockRejectedValue(new Error("boom")),
    } as unknown as LlmClient
    const soul = await generatePetSoul(client, makeBones(), { now: 4000 })
    expect(soul.name).toBeTruthy()
  })

  it("falls back when the LLM returns junk", async () => {
    const soul = await generatePetSoul(mockClient("totally not json"), makeBones(), { now: 5000 })
    expect(soul.name).toBeTruthy()
  })
})
