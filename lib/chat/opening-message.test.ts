import type { Character } from "@cognia/agent-config-types"

import { buildOpeningMessage } from "./opening-message"

function makeChar(p: Partial<Character> = {}): Character {
  return {
    id: "c1",
    name: "Tutor",
    avatarColor: "#abc",
    systemPrompt: "",
    createdAt: 0,
    updatedAt: 0,
    ...p,
  } as Character
}

describe("buildOpeningMessage", () => {
  it("returns an assistant message with the persona opening line", () => {
    const msg = buildOpeningMessage(
      makeChar({ persona: { openingMessage: "Hi! How can I help you today?" } })
    )
    expect(msg).not.toBeNull()
    expect(msg?.role).toBe("assistant")
    expect(msg?.parts).toEqual([
      { type: "text", text: "Hi! How can I help you today?", state: "done" },
    ])
    expect(msg?.id).toMatch(/^opening-/)
  })

  it("trims the opening message", () => {
    const msg = buildOpeningMessage(makeChar({ persona: { openingMessage: "  hello  " } }))
    expect(msg?.parts).toEqual([{ type: "text", text: "hello", state: "done" }])
  })

  it("returns null when there is no persona opening message", () => {
    expect(buildOpeningMessage(makeChar())).toBeNull()
    expect(buildOpeningMessage(makeChar({ persona: { tone: "warm" } }))).toBeNull()
    expect(buildOpeningMessage(makeChar({ persona: { openingMessage: "   " } }))).toBeNull()
  })

  it("returns null for a missing character", () => {
    expect(buildOpeningMessage(null)).toBeNull()
    expect(buildOpeningMessage(undefined)).toBeNull()
  })
})
