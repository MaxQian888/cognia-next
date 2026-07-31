const listMessages = jest.fn(async () => [
  { role: "user", parts: [{ type: "text", text: "from the message store" }] },
])
jest.mock("@/lib/db/messages", () => ({
  listMessages: (...a: unknown[]) => listMessages(...(a as [])),
}))

import {
  defaultPromptLoader,
  resolveTracePrompt,
  resolveTracePrompts,
  type SessionMessageLoader,
} from "./trace-prompt"

const userMessage = (text: string) => ({ role: "user", parts: [{ type: "text", text }] })
const assistantMessage = (text: string) => ({ role: "assistant", parts: [{ type: "text", text }] })

function loader(map: Record<string, { role?: string; parts?: unknown[] }[]>): SessionMessageLoader {
  return async (sessionId) => map[sessionId] ?? []
}

describe("resolveTracePrompt", () => {
  it("returns the first user message, skipping assistant turns", async () => {
    const load = loader({
      s1: [assistantMessage("hello!"), userMessage("what is 2+2?"), userMessage("and 3+3?")],
    })
    expect(await resolveTracePrompt("s1", load)).toBe("what is 2+2?")
  })

  it("joins several text parts of one message", async () => {
    const load = loader({
      s1: [
        {
          role: "user",
          parts: [
            { type: "text", text: "line one" },
            { type: "text", text: "line two" },
          ],
        },
      ],
    })
    expect(await resolveTracePrompt("s1", load)).toBe("line one\nline two")
  })

  it("ignores non-text parts", async () => {
    const load = loader({
      s1: [
        {
          role: "user",
          parts: [
            { type: "file", url: "x" },
            { type: "text", text: "describe this" },
          ],
        },
      ],
    })
    expect(await resolveTracePrompt("s1", load)).toBe("describe this")
  })

  it("skips a user message with no text at all", async () => {
    const load = loader({
      s1: [{ role: "user", parts: [{ type: "file", url: "x" }] }, userMessage("the real question")],
    })
    expect(await resolveTracePrompt("s1", load)).toBe("the real question")
  })

  it("returns undefined for a blank id, an empty session, or a load failure", async () => {
    expect(await resolveTracePrompt("", loader({}))).toBeUndefined()
    expect(await resolveTracePrompt("gone", loader({}))).toBeUndefined()
    const throwing: SessionMessageLoader = async () => {
      throw new Error("db closed")
    }
    // A cleared session is a fallback to the preview, not a crash.
    expect(await resolveTracePrompt("s1", throwing)).toBeUndefined()
  })

  it("tolerates a message with no parts array", async () => {
    expect(await resolveTracePrompt("s1", loader({ s1: [{ role: "user" }] }))).toBeUndefined()
  })
})

describe("resolveTracePrompts", () => {
  it("keys prompts by trace id", async () => {
    const load = loader({ s1: [userMessage("first")], s2: [userMessage("second")] })
    const out = await resolveTracePrompts(
      [
        { traceId: "t1", sessionId: "s1" },
        { traceId: "t2", sessionId: "s2" },
      ],
      load
    )
    expect(out).toEqual({ t1: "first", t2: "second" })
  })

  it("loads a shared session once and maps it onto every trace in it", async () => {
    const load = jest.fn<ReturnType<SessionMessageLoader>, [string]>(async () => [
      userMessage("shared"),
    ])
    const out = await resolveTracePrompts(
      [
        { traceId: "t1", sessionId: "s1" },
        { traceId: "t2", sessionId: "s1" },
      ],
      load
    )
    expect(out).toEqual({ t1: "shared", t2: "shared" })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("omits traces with no session or no recoverable prompt", async () => {
    const out = await resolveTracePrompts(
      [
        { traceId: "t1", sessionId: "" },
        { traceId: "t2", sessionId: "gone" },
      ],
      loader({})
    )
    expect(out).toEqual({})
  })
})

describe("defaultPromptLoader", () => {
  it("reads the real message store", async () => {
    expect(await resolveTracePrompt("s1", defaultPromptLoader())).toBe("from the message store")
    expect(listMessages).toHaveBeenCalledWith("s1")
  })
})
