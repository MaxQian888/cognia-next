import { speakAsPet, chatAsPet, sanitizeReply, sanitizeChatReply } from "./speak"
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

  it("keeps the legacy system prompt when no extra layers are passed", async () => {
    const c = client("ok")
    await speakAsPet(c, { soul, bones, userText: "hello" })
    const system = (c.complete as jest.Mock).mock.calls[0][1].system as string
    expect(system).toBe(
      `You are Boba, a rare cat desktop pet. ` +
        `Personality: smug and sleepy. ` +
        `Reply in ONE short, playful sentence, in character. ` +
        `Never reveal or ask for personal data. Do not give long answers.`
    )
  })

  it("layers state/history/recall/emotion/locale into the system prompt", async () => {
    const c = client("[happy] yay")
    await speakAsPet(c, {
      soul,
      bones,
      userText: "hello",
      state: { mood: "content", energy: 50, bond: 30, level: 2 },
      historyText: "User: hi\nYou: hey",
      recallText: "- Works late",
      emotionInstruction: true,
      locale: "zh-CN",
    })
    const system = (c.complete as jest.Mock).mock.calls[0][1].system as string
    expect(system).toContain("mood: content")
    expect(system).toContain("Recent things you said together:")
    expect(system).toContain("## What you remember about the user")
    expect(system).toContain("emotion tag in square brackets")
    expect(system).toContain("(zh-CN)")
  })
})

describe("sanitizeChatReply", () => {
  it("preserves paragraph breaks and strips wrapping quotes", () => {
    expect(sanitizeChatReply('  "First line.\n\nSecond line."  ')).toBe(
      "First line.\n\nSecond line."
    )
  })

  it("collapses runaway blank lines and returns '' for empty input", () => {
    expect(sanitizeChatReply("a\n\n\n\nb")).toBe("a\n\nb")
    expect(sanitizeChatReply("   ")).toBe("")
  })

  it("caps very long replies", () => {
    const long = "x".repeat(2000)
    expect(sanitizeChatReply(long).length).toBe(1200)
  })
})

describe("chatAsPet", () => {
  it("returns null without a client", async () => {
    expect(await chatAsPet(null, { soul, bones, userText: "hi" })).toBeNull()
  })

  it("returns a multi-line reply and uses the conversational persona + larger budget", async () => {
    const c = client("Sure!\n\nHere is a longer, chattier answer.")
    const res = await chatAsPet(c, { soul, bones, userText: "tell me about cats" })
    expect(res).toBe("Sure!\n\nHere is a longer, chattier answer.")
    const [, opts] = (c.complete as jest.Mock).mock.calls[0]
    expect(opts.maxTokens).toBe(400)
    expect(opts.system).toContain("Reply conversationally")
    expect(opts.system).not.toContain("ONE short, playful sentence")
  })

  it("blocks PII and returns null on empty/thrown output", async () => {
    const pii = client("nope")
    expect(
      await chatAsPet(pii, { soul, bones, userText: "my email is jane.doe@example.com" })
    ).toBeNull()
    expect(pii.complete).not.toHaveBeenCalled()
    expect(await chatAsPet(client("   "), { soul, bones, userText: "hi" })).toBeNull()
    const boom = { complete: jest.fn().mockRejectedValue(new Error("x")) } as unknown as LlmClient
    expect(await chatAsPet(boom, { soul, bones, userText: "hi" })).toBeNull()
  })
})
