// Mock jszip with a constructor-style mock
const mockZipFile = jest.fn()
const mockGenerateAsync = jest.fn(async () => new Blob([""]))
jest.mock("jszip", () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      file: mockZipFile,
      generateAsync: mockGenerateAsync,
    })),
  }
})

jest.mock("@/lib/db/messages", () => ({
  listMessages: jest.fn(),
}))
jest.mock("@/lib/export/single", () => ({
  renderSingleExport: jest.fn(() => ({
    content: "x",
    filename: "same.md",
    mimeType: "text/markdown",
  })),
}))
jest.mock("@/lib/db/schema", () => {
  type MsgsChain = { where: jest.Mock; equals: jest.Mock; sortBy: jest.Mock }
  const msgs: MsgsChain = {
    where: jest.fn(() => msgs),
    equals: jest.fn(() => msgs),
    sortBy: jest.fn(),
  }
  return {
    getDb: () => ({ messages: msgs }),
    __msgs: msgs,
  }
})

import { exportBatch } from "./batch-export"
import { listMessages } from "@/lib/db/messages"
import { renderSingleExport } from "@/lib/export/single"
import type { ChatSession } from "@/lib/claude/types"
import * as schema from "@/lib/db/schema"

const mockedList = listMessages as unknown as jest.Mock
const mockedRender = renderSingleExport as unknown as jest.Mock
const msgs = (schema as unknown as { __msgs: { sortBy: jest.Mock } }).__msgs

beforeEach(() => {
  jest.clearAllMocks()
})

const session = (id: string, title: string): ChatSession =>
  ({ id, title }) as unknown as ChatSession

describe("exportBatch", () => {
  it("skips sessions with no messages and reports progress", async () => {
    mockedList.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "x" }])
    msgs.sortBy.mockResolvedValueOnce([{ id: "row" }])
    mockedRender.mockReturnValueOnce({
      content: "X",
      filename: "out.md",
      mimeType: "text/markdown",
    })
    const onProgress = jest.fn()
    const result = await exportBatch({
      sessions: [session("a", "A"), session("b", "B")],
      format: "markdown",
      onProgress,
    })
    expect(result.exportedCount).toBe(1)
    expect(mockZipFile).toHaveBeenCalledWith("out.md", "X")
    expect(result.filename).toMatch(/^cognia-batch-export-\d{4}-\d{2}-\d{2}\.zip$/)
    // start + final
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ completed: 0, total: 2 }))
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ completed: 2, total: 2, currentTitle: "" })
    )
  })

  it("disambiguates duplicate filenames by appending suffix before extension", async () => {
    mockedList.mockResolvedValueOnce([{ id: "u" }]).mockResolvedValueOnce([{ id: "u2" }])
    msgs.sortBy.mockResolvedValue([{ id: "row" }])
    mockedRender.mockReturnValue({
      content: "C",
      filename: "same.md",
      mimeType: "text/markdown",
    })
    await exportBatch({
      sessions: [session("a", "A"), session("b", "B")],
      format: "markdown",
    })
    expect(mockZipFile).toHaveBeenCalledTimes(2)
    expect(mockZipFile).toHaveBeenNthCalledWith(1, "same.md", "C")
    // Second hit: " (2)" suffix inserted before ".md"
    expect(mockZipFile).toHaveBeenNthCalledWith(2, "same (2).md", "C")
  })

  it("appends suffix at end when filename has no dot", async () => {
    mockedList.mockResolvedValueOnce([{ id: "u" }]).mockResolvedValueOnce([{ id: "u2" }])
    msgs.sortBy.mockResolvedValue([{ id: "row" }])
    mockedRender.mockReturnValue({
      content: "C",
      filename: "noext",
      mimeType: "text/plain",
    })
    await exportBatch({
      sessions: [session("a", "A"), session("b", "B")],
      format: "text",
    })
    expect(mockZipFile).toHaveBeenNthCalledWith(2, "noext (2)", "C")
  })

  it("reconstitutes when DB returns no rows but UIMessage list is non-empty", async () => {
    mockedList.mockResolvedValueOnce([
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
    ])
    msgs.sortBy.mockResolvedValueOnce([])
    mockedRender.mockImplementationOnce((opts: { messages: unknown[] }) => {
      // Return a filename based on whether the messages list is non-empty.
      expect(opts.messages.length).toBe(1)
      return { content: "ok", filename: "ok.md", mimeType: "text/markdown" }
    })
    const out = await exportBatch({
      sessions: [session("a", "A")],
      format: "markdown",
    })
    expect(out.exportedCount).toBe(1)
  })
})
