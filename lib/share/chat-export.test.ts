import { buildChatSharePayload, buildMultiChatSharePayload } from "./chat-export"
import type { ChatSession } from "@cognia/agent-config-types"

const sortBy = jest.fn().mockResolvedValue([{ id: "m1" }])
const anyOf = jest.fn(() => ({ sortBy }))
const getCharacter = jest.fn()
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    messages: { where: () => ({ equals: () => ({ sortBy }), anyOf }) },
    characters: { get: getCharacter },
  }),
}))

const renderSingleExport = jest.fn((_arg: unknown) => ({
  content: "RENDERED",
  mimeType: "text/html",
  filename: "x.html",
}))
jest.mock("@/lib/export/single", () => ({
  renderSingleExport: (arg: unknown) => renderSingleExport(arg),
}))

const session = { id: "s1", title: "My chat" } as ChatSession

beforeEach(() => {
  jest.clearAllMocks()
  getCharacter.mockResolvedValue(undefined)
})

describe("buildChatSharePayload", () => {
  it("fetches messages, renders, and wraps as a chat payload", async () => {
    const payload = await buildChatSharePayload({ format: "html", session })
    expect(sortBy).toHaveBeenCalledWith("createdAt")
    expect(renderSingleExport).toHaveBeenCalledWith(
      expect.objectContaining({ format: "html", session, messages: [{ id: "m1" }] })
    )
    expect(payload).toEqual({
      kind: "chat-html",
      mime: "text/html",
      data: "RENDERED",
      encoding: "utf8",
      title: "My chat",
    })
  })

  it("falls back to a default title when the session has none", async () => {
    const payload = await buildChatSharePayload({
      format: "text",
      session: { id: "s2", title: "" } as ChatSession,
    })
    expect(payload.title).toBe("Conversation")
  })

  it("attaches encrypted structured provenance for a twin-bound conversation", async () => {
    getCharacter.mockResolvedValueOnce({ id: "character-1", twinId: "twin-1" })
    const payload = await buildChatSharePayload({
      format: "text",
      session: { id: "s3", title: "Twin", characterId: "character-1" } as ChatSession,
    })
    expect(payload.provenance).toEqual([
      { source: "digital-twin", sourceId: "twin-1", disclosure: "ai-generated" },
    ])
  })
})

describe("buildMultiChatSharePayload", () => {
  it("preserves selection order while reusing the single-conversation renderer", async () => {
    const sessions = [
      { id: "s1", title: "First" },
      { id: "s2", title: "Second" },
    ] as ChatSession[]
    sortBy.mockResolvedValueOnce([
      { id: "m-first", sessionId: "s1" },
      { id: "m-second", sessionId: "s2" },
    ])
    renderSingleExport
      .mockReturnValueOnce({
        content: "<html><body>FIRST TRANSCRIPT</body></html>",
        mimeType: "text/html",
        filename: "first.html",
      })
      .mockReturnValueOnce({
        content: "<html><body>SECOND TRANSCRIPT</body></html>",
        mimeType: "text/html",
        filename: "second.html",
      })

    const payload = await buildMultiChatSharePayload({
      sessions,
      title: "Selected conversations",
      copy: {
        count: "2 conversations",
        navigationLabel: "Shared conversations",
        previous: "Previous conversation",
        next: "Next conversation",
        frameTitle: "Conversation",
      },
    })

    expect(anyOf).toHaveBeenCalledWith(["s1", "s2"])
    expect(sortBy).toHaveBeenCalledTimes(1)
    expect(renderSingleExport).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        format: "html",
        session: sessions[0],
        messages: [{ id: "m-first", sessionId: "s1" }],
      })
    )
    expect(renderSingleExport).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        format: "html",
        session: sessions[1],
        messages: [{ id: "m-second", sessionId: "s2" }],
      })
    )
    expect(payload).toMatchObject({
      kind: "chat-animated",
      mime: "text/html",
      encoding: "utf8",
      title: "Selected conversations",
    })
    expect(payload.data.match(/<iframe/g)).toHaveLength(1)
    expect(payload.data.indexOf("FIRST TRANSCRIPT")).toBeLessThan(
      payload.data.indexOf("SECOND TRANSCRIPT")
    )
  })

  it("escapes session data before embedding it in the executable bundle", async () => {
    sortBy.mockResolvedValueOnce([])
    renderSingleExport.mockReturnValueOnce({
      content: "</script><img src=x onerror=alert(1)>",
      mimeType: "text/html",
      filename: "unsafe.html",
    })

    const payload = await buildMultiChatSharePayload({
      sessions: [{ id: "unsafe", title: "</script><img src=x>" } as ChatSession],
      title: "</script><img src=x>",
      copy: {
        count: "1 conversation",
        navigationLabel: "Shared conversations",
        previous: "Previous conversation",
        next: "Next conversation",
        frameTitle: "Conversation",
      },
    })

    expect(payload.data).not.toContain("</script><img src=x")
    expect(payload.data).toContain("\\u003c/script\\u003e")
    expect(payload.data).toContain("&lt;/script&gt;&lt;img src=x&gt;")
  })
})
