import { retrieveKnowledge, knowledgeRag, buildProjectContext } from "./knowledge-rag"
import type { Project } from "@/types"

describe("retrieveKnowledge", () => {
  it("returns an empty chunk list", async () => {
    expect(await retrieveKnowledge({ query: "x" })).toEqual([])
  })

  it("accepts a topK option", async () => {
    expect(await retrieveKnowledge({ query: "x", topK: 5 })).toEqual([])
  })
})

describe("knowledgeRag", () => {
  it("aliases retrieve to retrieveKnowledge", async () => {
    expect(await knowledgeRag.retrieve({ query: "y" })).toEqual([])
  })
})

describe("buildProjectContext", () => {
  it("returns an empty system prompt and chunk list with default args", () => {
    expect(buildProjectContext(undefined, undefined)).toEqual({
      systemPrompt: "",
      chunks: [],
    })
  })

  it("ignores the project / userQuery / options arguments", () => {
    const project = { id: "p" } as unknown as Project
    expect(
      buildProjectContext(project, "query", {
        maxContextLength: 10,
        useRelevanceFiltering: true,
      })
    ).toEqual({ systemPrompt: "", chunks: [] })
  })
})
