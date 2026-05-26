import { buildChatSharePayload } from "./chat-export"
import type { ChatSession } from "@/lib/claude/types"

const sortBy = jest.fn().mockResolvedValue([{ id: "m1" }])
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    messages: { where: () => ({ equals: () => ({ sortBy }) }) },
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

beforeEach(() => jest.clearAllMocks())

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
})
