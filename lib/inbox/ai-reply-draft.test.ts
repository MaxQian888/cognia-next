import { generateReplyDraft } from "./ai-reply-draft"

jest.mock("@cognia/redact", () => ({
  hasNoLeakingPii: jest.fn((text: string) => !text.includes("secret-token")),
}))

it("uses conversation context and explicit instructions without sending a platform message", async () => {
  const client = { complete: jest.fn().mockResolvedValue("  Tomorrow works.  ") }
  const signal = new AbortController().signal
  await expect(
    generateReplyDraft({
      history: [{ role: "user", text: "Meet tomorrow?" }],
      instructions: "Accept politely",
      client,
      signal,
    })
  ).resolves.toEqual({ kind: "draft", text: "Tomorrow works." })
  expect(client.complete).toHaveBeenCalledWith(
    expect.stringContaining("Meet tomorrow?"),
    expect.objectContaining({ abortSignal: signal })
  )
  expect(client.complete.mock.calls[0][0]).toContain("Accept politely")
})

it.each(["history", "instructions"])(
  "blocks PII from %s before calling the model",
  async (source) => {
    const client = { complete: jest.fn() }
    const result = await generateReplyDraft({
      history: [{ role: "user", text: source === "history" ? "secret-token" : "Hello" }],
      instructions: source === "instructions" ? "secret-token" : "",
      client,
    })
    expect(result).toEqual({ kind: "skipped", reason: "pii" })
    expect(client.complete).not.toHaveBeenCalled()
  }
)

it("does not call the model without context", async () => {
  const client = { complete: jest.fn() }
  await expect(generateReplyDraft({ history: [], instructions: "  ", client })).resolves.toEqual({
    kind: "skipped",
    reason: "empty",
  })
  expect(client.complete).not.toHaveBeenCalled()
})

it.each(["", "x".repeat(16001)])("rejects unusable output", async (text) => {
  await expect(
    generateReplyDraft({
      history: [],
      instructions: "Say hi",
      client: { complete: jest.fn().mockResolvedValue(text) },
    })
  ).resolves.toEqual({ kind: "skipped", reason: "no-output" })
})

it("propagates failures for the UI to preserve its draft", async () => {
  await expect(
    generateReplyDraft({
      history: [],
      instructions: "Say hi",
      client: { complete: jest.fn().mockRejectedValue(new Error("offline")) },
    })
  ).rejects.toThrow("offline")
})

it("does not dispatch an already canceled draft", async () => {
  const controller = new AbortController()
  controller.abort()
  const client = { complete: jest.fn().mockResolvedValue("unused") }
  await expect(
    generateReplyDraft({ history: [], instructions: "Reply", client, signal: controller.signal })
  ).rejects.toMatchObject({ name: "AbortError" })
  expect(client.complete).not.toHaveBeenCalled()
})

it("discards a late response from a client that ignores cancellation", async () => {
  const controller = new AbortController()
  const client = {
    complete: jest.fn(async () => {
      controller.abort()
      return "late draft"
    }),
  }
  await expect(
    generateReplyDraft({ history: [], instructions: "Reply", client, signal: controller.signal })
  ).rejects.toMatchObject({ name: "AbortError" })
})
