/** @jest-environment jsdom */
import {
  buildLiveVoiceContext,
  buildLiveVoiceContextEvent,
  type LiveVoiceContextMessage,
} from "./context"

function message(role: string, ...texts: string[]): LiveVoiceContextMessage {
  return { role, parts: texts.map((text) => ({ type: "text", text })) }
}

const LIMITS = { turnLimit: 12, characterLimit: 16_000 }

describe("buildLiveVoiceContext", () => {
  it("returns nothing for an empty history", () => {
    expect(buildLiveVoiceContext([], LIMITS)).toBeNull()
  })

  it("renders the conversation oldest-first", () => {
    const transcript = buildLiveVoiceContext(
      [message("user", "what is it"), message("assistant", "a badger")],
      LIMITS
    )

    expect(transcript).toContain("User: what is it\nAssistant: a badger")
  })

  it("frames the transcript so the model does not read it aloud", () => {
    // Without framing, models reliably start the session by narrating history.
    const transcript = buildLiveVoiceContext([message("user", "hi")], LIMITS)
    expect(transcript).toMatch(/do not read this transcript aloud/i)
  })

  it("joins several text parts of one message", () => {
    const transcript = buildLiveVoiceContext([message("user", "hello", "there")], LIMITS)
    expect(transcript).toContain("User: hello there")
  })

  it("drops attachments, tool calls and every other non-text part", () => {
    // The user consented to their microphone reaching the provider, not their
    // files.
    const transcript = buildLiveVoiceContext(
      [
        {
          role: "user",
          parts: [
            { type: "file", mediaType: "image/png", data: "secret" },
            { type: "text", text: "look at this" },
            { type: "dynamic-tool", toolName: "read_file", input: { path: "/etc/passwd" } },
          ],
        },
      ],
      LIMITS
    )

    expect(transcript).toContain("User: look at this")
    expect(transcript).not.toContain("secret")
    expect(transcript).not.toContain("passwd")
  })

  it("skips system messages and unknown roles", () => {
    const transcript = buildLiveVoiceContext(
      [message("system", "you are a bot"), message("data", "junk"), message("user", "hi")],
      LIMITS
    )

    expect(transcript).toContain("User: hi")
    expect(transcript).not.toContain("you are a bot")
    expect(transcript).not.toContain("junk")
  })

  it("skips a message with no text parts", () => {
    expect(buildLiveVoiceContext([{ role: "user", parts: [] }], LIMITS)).toBeNull()
    expect(buildLiveVoiceContext([{ role: "user" }], LIMITS)).toBeNull()
  })

  it("keeps only the most recent turns", () => {
    const messages = Array.from({ length: 20 }, (_, i) => message("user", `turn ${i}`))

    const transcript = buildLiveVoiceContext(messages, { ...LIMITS, turnLimit: 3 })

    expect(transcript).toContain("turn 17")
    expect(transcript).toContain("turn 19")
    expect(transcript).not.toContain("turn 16")
  })

  it("drops the oldest lines when the character budget is tight", () => {
    const messages = [
      message("user", "x".repeat(200)),
      message("assistant", "y".repeat(200)),
      message("user", "the recent one"),
    ]

    const transcript = buildLiveVoiceContext(messages, { turnLimit: 12, characterLimit: 400 })

    // Recency is what matters — the newest turn must survive.
    expect(transcript).toContain("the recent one")
    expect(transcript!.length).toBeLessThanOrEqual(400)
  })

  it("truncates rather than dropping when a single turn busts the budget", () => {
    // There is no earlier line left to shed, and some context beats none.
    const transcript = buildLiveVoiceContext([message("user", "z".repeat(500))], {
      turnLimit: 12,
      characterLimit: 200,
    })

    expect(transcript).not.toBeNull()
    expect(transcript!.length).toBe(200)
  })

  it("returns nothing when the limits leave no room", () => {
    expect(buildLiveVoiceContext([message("user", "hi")], { ...LIMITS, turnLimit: 0 })).toBeNull()
    expect(
      buildLiveVoiceContext([message("user", "hi")], { ...LIMITS, characterLimit: 0 })
    ).toBeNull()
  })

  it("redacts a line that carries PII", () => {
    const transcript = buildLiveVoiceContext(
      [message("user", "email me at alice@example.com about it")],
      LIMITS
    )

    expect(transcript).not.toContain("alice@example.com")
    expect(transcript).toContain("User:")
  })

  it("keeps the rest of the conversation when one line is dropped", () => {
    const transcript = buildLiveVoiceContext(
      [message("user", "   "), message("assistant", "still here")],
      LIMITS
    )

    expect(transcript).toContain("Assistant: still here")
  })
})

describe("buildLiveVoiceContextEvent", () => {
  it("injects the transcript as a user text item", () => {
    // V4 offers no assistant-role client item, so replaying the history as
    // separate roles is not an option — the framing carries the distinction.
    expect(buildLiveVoiceContextEvent("User: hi")).toEqual({
      type: "conversation-item-create",
      item: { type: "text-message", role: "user", text: "User: hi" },
    })
  })
})
