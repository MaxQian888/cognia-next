jest.mock("ai", () => ({
  tool: jest.fn((config) => ({ type: "tool", ...config })),
}))

import { tool } from "ai"
import { z } from "zod"
import { combineTools, createTool } from "./tool-utils"

describe("RAG tool utilities", () => {
  it("creates AI SDK tools with inputSchema", async () => {
    const execute = jest.fn(async (input: { question: string }) => input.question)
    const inputSchema = z.object({ question: z.string() })

    const created = createTool({
      description: "Ask",
      inputSchema,
      execute,
      strict: true,
    }) as { inputSchema: typeof inputSchema; execute: typeof execute; strict: boolean }

    expect(tool).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Ask",
        inputSchema,
        execute,
        strict: true,
      })
    )
    expect(created.inputSchema).toBe(inputSchema)
    await expect(created.execute({ question: "hello" })).resolves.toBe("hello")
  })

  it("combines multiple tool maps", () => {
    expect(combineTools({ a: 1 } as never, { b: 2 } as never)).toEqual({ a: 1, b: 2 })
  })
})
