import type { UIMessage } from "ai"
import type { SendContent } from "@cognia/agent-config-types"
import {
  externalLaneMemory,
  foreignTurnsHandoffText,
  laneMemoryOf,
  sameLaneMemory,
  prefixForeignTurnsContext,
  unseenForeignTurns,
  withForeignTurnsContext,
} from "./history"

function user(id: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text: id }] }
}
function reply(id: string, providerId?: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text: id }],
    ...(providerId ? { metadata: { run: { providerId } } } : {}),
  }
}
function routed(id: string, agentId: string, route: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text: id }],
    metadata: { run: { providerId: "external", externalAgent: { agentId, route } } },
  }
}
const system: UIMessage = { id: "sys", role: "system", parts: [{ type: "text", text: "s" }] }

describe("laneMemoryOf", () => {
  it("reads the lane from the sealed provider", () => {
    expect(laneMemoryOf(reply("a", "external"))).toBe("external")
    expect(laneMemoryOf(reply("a", "anthropic"))).toBe("builtin")
    expect(laneMemoryOf(reply("a", "deepseek"))).toBe("builtin")
  })

  it("is evidence of nothing without a provider, or for a user row", () => {
    expect(laneMemoryOf(reply("a"))).toBeNull()
    expect(laneMemoryOf(user("u"))).toBeNull()
  })
})

describe("unseenForeignTurns", () => {
  it("hands the builtin lane what Codex said since the last builtin reply", () => {
    const history = [
      user("u1"),
      reply("a1", "anthropic"),
      user("u2"),
      reply("a2", "external"),
      system,
    ]
    expect(unseenForeignTurns(history, "builtin").map((m) => m.id)).toEqual(["u2", "a2"])
  })

  it("hands Codex what the builtin lane said since Codex last answered", () => {
    const history = [
      user("u1"),
      reply("a1", "external"),
      user("u2"),
      reply("a2", "anthropic"),
      user("u3"),
      reply("a3", "anthropic"),
    ]
    expect(unseenForeignTurns(history, "external").map((m) => m.id)).toEqual([
      "u2",
      "a2",
      "u3",
      "a3",
    ])
  })

  it("is empty when no other lane has spoken since", () => {
    const history = [user("u1"), reply("a1", "external"), user("u2"), reply("a2", "anthropic")]
    expect(unseenForeignTurns(history, "builtin")).toEqual([])
    expect(unseenForeignTurns([user("u1"), reply("a1", "anthropic")], "builtin")).toEqual([])
    expect(unseenForeignTurns([], "builtin")).toEqual([])
  })

  it("covers everything when the lane never answered", () => {
    const history = [user("u1"), reply("a1", "external")]
    expect(unseenForeignTurns(history, "builtin").map((m) => m.id)).toEqual(["u1", "a1"])
  })

  it("stops at the last foreign reply, leaving a replayed follow-up to the turn", () => {
    const history = [user("u1"), reply("a1", "external"), user("queued follow-up")]
    expect(unseenForeignTurns(history, "builtin").map((m) => m.id)).toEqual(["u1", "a1"])
  })

  it("ignores unsealed replies on both sides", () => {
    const history = [user("u1"), reply("partial"), user("u2")]
    expect(unseenForeignTurns(history, "builtin")).toEqual([])
  })
})

describe("withForeignTurnsContext / prefixForeignTurnsContext", () => {
  it("labels the request after the handoff, and passes text through without one", () => {
    expect(withForeignTurnsContext("CTX", "do it")).toBe("CTX\n\nCurrent user request:\ndo it")
    expect(withForeignTurnsContext("", "do it")).toBe("do it")
  })

  it("prefixes string content and the first text block of block content", () => {
    expect(prefixForeignTurnsContext("do it", "CTX")).toBe("CTX\n\nCurrent user request:\ndo it")
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "A" },
    } as const
    expect(
      prefixForeignTurnsContext([image, { type: "text", text: "look" }] as SendContent, "CTX")
    ).toEqual([image, { type: "text", text: "CTX\n\nCurrent user request:\nlook" }])
  })

  it("adds a text block when the content has none, and changes nothing without context", () => {
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "A" },
    } as const
    expect(prefixForeignTurnsContext([image] as SendContent, "CTX")).toEqual([
      { type: "text", text: "CTX" },
      image,
    ])
    const content = [image] as SendContent
    expect(prefixForeignTurnsContext(content, "")).toBe(content)
  })

  it("puts the handoff in front of attached files, never inside a file's text", () => {
    // An extracted document is a text block too, and leads the turn.
    const file = { type: "text" as const, text: "Q3 revenue grew 12%." }
    const typed = { type: "text" as const, text: "what drove it?" }
    expect(prefixForeignTurnsContext([file, typed], "CTX", 1)).toEqual([
      { type: "text", text: "CTX\n\nCurrent user request:" },
      file,
      typed,
    ])
  })
})

const handoff = {
  build: jest.fn(),
  prepare: jest.fn(),
}
jest.mock("@/lib/chat/handoff-context", () => ({
  buildHandoffContext: (...args: unknown[]) => handoff.build(...args),
  prepareHandoffContext: (...args: unknown[]) => handoff.prepare(...args),
}))

describe("foreignTurnsHandoffText", () => {
  beforeEach(() => {
    handoff.build.mockReset()
    handoff.prepare.mockReset()
  })

  it("hands over nothing for no messages, without projecting", async () => {
    const client = jest.fn()
    await expect(foreignTurnsHandoffText([], { client })).resolves.toBe("")
    expect(handoff.build).not.toHaveBeenCalled()
    expect(client).not.toHaveBeenCalled()
  })

  it("uses the projection as is when it fits, without building a client", async () => {
    handoff.build.mockReturnValue({ text: "PROJECTED", losses: [], omittedMessageIds: [] })
    const client = jest.fn()
    await expect(foreignTurnsHandoffText([user("u")], { client })).resolves.toBe("PROJECTED")
    expect(client).not.toHaveBeenCalled()
  })

  it("asks for a summary over budget, through the caller's client", async () => {
    handoff.build.mockReturnValue({
      text: "HEAD+TAIL",
      losses: [{ kind: "budget", messageId: "u", detail: "" }],
      omittedMessageIds: ["u"],
    })
    handoff.prepare.mockResolvedValue({ text: "SUMMARY", losses: [], omittedMessageIds: [] })
    const llm = { id: "client" }
    const signal = new AbortController().signal
    await expect(
      foreignTurnsHandoffText([user("u")], { client: async () => llm as never, signal })
    ).resolves.toBe("SUMMARY")
    expect(handoff.prepare).toHaveBeenCalledWith([user("u")], { client: llm, signal })
  })

  it("carries imported task state into the projection and the summary", async () => {
    handoff.build.mockReturnValue({
      text: "HEAD+TAIL",
      losses: [{ kind: "budget", messageId: "u", detail: "" }],
      omittedMessageIds: ["u"],
    })
    handoff.prepare.mockRejectedValue(new Error("handoff_context_summary_unavailable:no-client"))
    const state = { tasks: [{ id: "t1" }] }
    await expect(
      foreignTurnsHandoffText([user("u")], { client: async () => null, state })
    ).resolves.toBe("HEAD+TAIL")
    expect(handoff.build).toHaveBeenCalledWith([user("u")], { state })
    expect(handoff.prepare).toHaveBeenCalledWith([user("u")], { state, client: null })
  })

  it.each(["no-client", "no-output"])(
    "keeps the honest head/tail projection when the summary is unavailable (%s)",
    async (reason) => {
      handoff.build.mockReturnValue({
        text: "HEAD+TAIL",
        losses: [{ kind: "budget", messageId: "u", detail: "" }],
        omittedMessageIds: ["u"],
      })
      handoff.prepare.mockRejectedValue(new Error(`handoff_context_summary_unavailable:${reason}`))
      await expect(
        foreignTurnsHandoffText([user("u")], { client: async () => null })
      ).resolves.toBe("HEAD+TAIL")
    }
  )

  it("fails on a PII refusal instead of handing over the refused material as an excerpt", async () => {
    handoff.build.mockReturnValue({
      text: "HEAD+TAIL",
      losses: [{ kind: "budget", messageId: "u", detail: "" }],
      omittedMessageIds: ["u"],
    })
    handoff.prepare.mockRejectedValue(new Error("handoff_context_summary_unavailable:pii"))
    await expect(
      foreignTurnsHandoffText([user("u")], { client: async () => ({}) as never })
    ).rejects.toThrow("handoff_context_summary_unavailable:pii")
  })

  it("fails on any other summary failure, as a lane switch's handoff does", async () => {
    handoff.build.mockReturnValue({
      text: "HEAD+TAIL",
      losses: [{ kind: "budget", messageId: "u", detail: "" }],
      omittedMessageIds: ["u"],
    })
    handoff.prepare.mockRejectedValue(new Error("upstream 500"))
    await expect(
      foreignTurnsHandoffText([user("u")], { client: async () => ({}) as never })
    ).rejects.toThrow("upstream 500")
  })
})

describe("per-route external memory", () => {
  const native = externalLaneMemory("kimi", "native")
  const task = externalLaneMemory("kimi", "cognia:task-1")

  it("reads an agent and route off a stamped reply", () => {
    expect(laneMemoryOf(routed("a", "kimi", "native"))).toBe(native)
    expect(laneMemoryOf(routed("a", "kimi", "cognia:task-1"))).toBe(task)
  })

  it("treats an unstamped external reply as seen by any external lane, never builtin", () => {
    expect(sameLaneMemory("external", task)).toBe(true)
    expect(sameLaneMemory(native, "external")).toBe(true)
    expect(sameLaneMemory(native, task)).toBe(false)
    expect(sameLaneMemory("external", "builtin")).toBe(false)
    expect(sameLaneMemory("builtin", "builtin")).toBe(true)
  })

  it("hands a native session resumed after Cognia turns what the Cognia task said", () => {
    const history = [
      user("u1"),
      routed("a1", "kimi", "native"),
      user("u2"),
      routed("a2", "kimi", "cognia:task-1"),
    ]
    expect(unseenForeignTurns(history, native).map((m) => m.id)).toEqual(["u2", "a2"])
    expect(unseenForeignTurns(history, task)).toEqual([])
  })

  it("hands a resumed Cognia task what the native session and other agents said", () => {
    const history = [
      user("u1"),
      routed("a1", "kimi", "cognia:task-1"),
      user("u2"),
      routed("a2", "kimi", "native"),
      user("u3"),
      routed("a3", "codex", "native"),
      user("u4"),
      reply("a4", "anthropic"),
    ]
    expect(unseenForeignTurns(history, task).map((m) => m.id)).toEqual([
      "u2",
      "a2",
      "u3",
      "a3",
      "u4",
      "a4",
    ])
  })
})
