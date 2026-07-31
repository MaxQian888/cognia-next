jest.mock("./retrieve", () => ({
  retrieveProjectChunks: jest.fn(),
}))

import { applyProjectKnowledgeContext } from "./apply-project-context"
import { retrieveProjectChunks } from "./retrieve"
import type { ProjectKnowledgeRuntimeDeps } from "./retrieve"

const retrieveMock = retrieveProjectChunks as jest.Mock

const deps = {} as ProjectKnowledgeRuntimeDeps

function hit(fileId: string, content: string, score = 1) {
  return { chunk: { fileId, content, vectorDocId: `${fileId}-0` }, score }
}

beforeEach(() => retrieveMock.mockReset())

describe("applyProjectKnowledgeContext", () => {
  it("returns empty (no retrieve) for a blank message", async () => {
    const res = await applyProjectKnowledgeContext({
      projectId: "p",
      userMessage: "  ",
      topK: 5,
      deps,
    })
    expect(res.systemPromptSection).toBeNull()
    expect(retrieveMock).not.toHaveBeenCalled()
  })

  it("returns empty (no retrieve) for topK<=0", async () => {
    await applyProjectKnowledgeContext({ projectId: "p", userMessage: "q", topK: 0, deps })
    expect(retrieveMock).not.toHaveBeenCalled()
  })

  it("assembles a section with file-name citations", async () => {
    retrieveMock.mockResolvedValue({
      chunks: [hit("f1", "alpha body"), hit("f2", "beta body")],
      degraded: false,
    })
    const res = await applyProjectKnowledgeContext({
      projectId: "p",
      userMessage: "q",
      topK: 5,
      fileNames: { f1: "guide.md", f2: "spec.md" },
      deps,
    })
    expect(res.systemPromptSection).toContain("## Project knowledge base")
    expect(res.systemPromptSection).toContain("[guide.md]")
    expect(res.systemPromptSection).toContain("alpha body")
    expect(res.systemPromptSection).toContain("[spec.md]")
    expect(res.retrievedChunks).toHaveLength(2)
    expect(res.retrievedChunks[0].fileName).toBe("guide.md")
  })

  it("falls back to a file-id label when the name is unknown", async () => {
    retrieveMock.mockResolvedValue({ chunks: [hit("f9", "x")], degraded: false })
    const res = await applyProjectKnowledgeContext({
      projectId: "p",
      userMessage: "q",
      topK: 5,
      deps,
    })
    expect(res.systemPromptSection).toContain("[file f9]")
  })

  it("returns null section but passes degraded through when nothing retrieved", async () => {
    retrieveMock.mockResolvedValue({ chunks: [], degraded: true })
    const res = await applyProjectKnowledgeContext({
      projectId: "p",
      userMessage: "q",
      topK: 5,
      deps,
    })
    expect(res.systemPromptSection).toBeNull()
    expect(res.degraded).toBe(true)
  })

  it("never throws — degrades when retrieve rejects", async () => {
    retrieveMock.mockRejectedValue(new Error("boom"))
    const res = await applyProjectKnowledgeContext({
      projectId: "p",
      userMessage: "q",
      topK: 5,
      deps,
    })
    expect(res).toEqual({ systemPromptSection: null, retrievedChunks: [], degraded: true })
  })
})
