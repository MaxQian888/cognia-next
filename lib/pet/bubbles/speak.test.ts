import { speakAsPet, sanitizeReply } from "./speak"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type { PetBones, PetSoul } from "@/types/pet"

const soul: PetSoul = { name: "Boba", personality: "smug and sleepy", hatchDate: "" }
const bones = { species: "cat", rarity: "rare" } as PetBones

function client(reply: string): LlmClient {
  return { complete: jest.fn().mockResolvedValue(reply) } as unknown as LlmClient
}

describe("sanitizeReply", () => {
  it("keeps a single trimmed line and strips quotes", () => {
    expect(sanitizeReply('  "Hello there"\nsecond ')).toBe("Hello there")
    expect(sanitizeReply("")).toBe("")
  })
})

describe("speakAsPet", () => {
  it("returns null without a client", async () => {
    expect(await speakAsPet(null, { soul, bones, userText: "hi" })).toBeNull()
  })

  it("returns the sanitized reply for safe text", async () => {
    const c = client("Mrrrp, hello!")
    expect(
      await speakAsPet(c, { soul, bones, userText: "hello", persona: "A terse engineer" })
    ).toBe("Mrrrp, hello!")
    expect(c.complete).toHaveBeenCalled()
  })

  it("blocks text that trips the PII gate (no LLM call)", async () => {
    const c = client("should not be used")
    const res = await speakAsPet(c, { soul, bones, userText: "my email is jane.doe@example.com" })
    expect(res).toBeNull()
    expect(c.complete).not.toHaveBeenCalled()
  })

  it("returns null on empty user text", async () => {
    expect(await speakAsPet(client("x"), { soul, bones, userText: "   " })).toBeNull()
  })

  it("returns null when the model throws", async () => {
    const c = { complete: jest.fn().mockRejectedValue(new Error("boom")) } as unknown as LlmClient
    expect(await speakAsPet(c, { soul, bones, userText: "hello" })).toBeNull()
  })

  it("returns null when the model output is empty", async () => {
    expect(await speakAsPet(client("   "), { soul, bones, userText: "hello" })).toBeNull()
  })
})
