/**
 * Tool Utilities Tests
 */

import { z } from "zod"
import {
  createTool,
  simpleTool,
  combineTools,
  hasApprovalRequests,
  extractApprovalRequests,
  createApprovalResponses,
  ToolRegistry,
  getDefaultToolRegistry,
  CommonSchemas,
  type ToolApprovalRequest,
} from "./tool-utils"

// Mock the AI SDK tool function
jest.mock("ai", () => ({
  tool: jest.fn((config) => ({
    ...config,
    __type: "tool",
  })),
}))

describe("Tool Utilities", () => {
  describe("createTool", () => {
    it("should create a tool with basic options", () => {
      const result = createTool({
        description: "Test tool",
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => ({ result: query }),
      })

      expect(result).toBeDefined()
      expect((result as { description: string }).description).toBe("Test tool")
    })

    it("should include strict mode when specified", () => {
      const result = createTool({
        description: "Strict tool",
        inputSchema: z.object({ data: z.string() }),
        execute: async () => ({}),
        strict: true,
      })

      expect((result as unknown as { strict: boolean }).strict).toBe(true)
    })

    it("should include needsApproval when specified", () => {
      const result = createTool({
        description: "Approval tool",
        inputSchema: z.object({}),
        execute: async () => ({}),
        needsApproval: true,
      })

      expect((result as unknown as { needsApproval: boolean }).needsApproval).toBe(true)
    })
  })

  describe("simpleTool", () => {
    it("should create a named tool object", () => {
      const tools = simpleTool(
        "search",
        "Search for items",
        z.object({ query: z.string() }),
        async ({ query }) => [query]
      )

      expect(tools).toHaveProperty("search")
      expect((tools.search as { description: string }).description).toBe("Search for items")
    })
  })

  describe("combineTools", () => {
    it("should merge multiple tool objects", () => {
      const tools1 = { tool1: { description: "Tool 1" } }
      const tools2 = { tool2: { description: "Tool 2" } }
      const tools3 = { tool3: { description: "Tool 3" } }

      const combined = combineTools(
        tools1 as unknown as Parameters<typeof combineTools>[0],
        tools2 as unknown as Parameters<typeof combineTools>[0],
        tools3 as unknown as Parameters<typeof combineTools>[0]
      )

      expect(combined).toHaveProperty("tool1")
      expect(combined).toHaveProperty("tool2")
      expect(combined).toHaveProperty("tool3")
    })
  })

  describe("approval workflow", () => {
    const mockApprovalRequests: ToolApprovalRequest[] = [
      {
        type: "tool-approval-request",
        approvalId: "approval-1",
        toolCall: {
          toolName: "deleteFile",
          input: { path: "/test" },
          toolCallId: "call-1",
        },
      },
      {
        type: "tool-approval-request",
        approvalId: "approval-2",
        toolCall: {
          toolName: "runCommand",
          input: { command: "rm -rf" },
          toolCallId: "call-2",
        },
      },
    ]

    describe("hasApprovalRequests", () => {
      it("should return true when approval requests exist", () => {
        const content = [{ type: "text", text: "Hello" }, mockApprovalRequests[0]]

        expect(hasApprovalRequests(content)).toBe(true)
      })

      it("should return false when no approval requests", () => {
        const content = [
          { type: "text", text: "Hello" },
          { type: "tool-result", result: "done" },
        ]

        expect(hasApprovalRequests(content)).toBe(false)
      })
    })

    describe("extractApprovalRequests", () => {
      it("should extract only approval requests", () => {
        const content = [
          { type: "text", text: "Hello" },
          mockApprovalRequests[0],
          { type: "tool-result" },
          mockApprovalRequests[1],
        ]

        const extracted = extractApprovalRequests(content)

        expect(extracted).toHaveLength(2)
        expect(extracted[0].approvalId).toBe("approval-1")
        expect(extracted[1].approvalId).toBe("approval-2")
      })
    })

    describe("createApprovalResponses", () => {
      it("should create responses for all requests", () => {
        const decisions = new Map([
          ["approval-1", { approved: true, reason: "Safe operation" }],
          ["approval-2", { approved: false, reason: "Too dangerous" }],
        ])

        const responses = createApprovalResponses(mockApprovalRequests, decisions)

        expect(responses).toHaveLength(2)
        expect(responses[0]).toEqual({
          type: "tool-approval-response",
          approvalId: "approval-1",
          approved: true,
          reason: "Safe operation",
        })
        expect(responses[1]).toEqual({
          type: "tool-approval-response",
          approvalId: "approval-2",
          approved: false,
          reason: "Too dangerous",
        })
      })

      it("should default to denied for missing decisions", () => {
        const decisions = new Map<string, { approved: boolean; reason?: string }>()

        const responses = createApprovalResponses([mockApprovalRequests[0]], decisions)

        expect(responses[0].approved).toBe(false)
        expect(responses[0].reason).toBe("No decision provided")
      })
    })
  })

  describe("ToolRegistry", () => {
    let registry: ToolRegistry

    beforeEach(() => {
      registry = new ToolRegistry()
    })

    it("should register and retrieve tools", () => {
      registry.register(
        "search",
        {
          description: "Search tool",
          inputSchema: z.object({ query: z.string() }),
          execute: async () => [],
        },
        { category: "search" }
      )

      const tool = registry.get("search")
      expect(tool).toBeDefined()
    })

    it("should return undefined for unregistered tools", () => {
      expect(registry.get("nonexistent")).toBeUndefined()
    })

    it("should get all tools as object", () => {
      registry.register(
        "tool1",
        {
          description: "Tool 1",
          inputSchema: z.object({}),
          execute: async () => ({}),
        },
        { category: "custom" }
      )
      registry.register(
        "tool2",
        {
          description: "Tool 2",
          inputSchema: z.object({}),
          execute: async () => ({}),
        },
        { category: "data" }
      )

      const tools = registry.getTools()

      expect(Object.keys(tools)).toEqual(["tool1", "tool2"])
    })

    it("should get tools by category", () => {
      registry.register(
        "search1",
        {
          description: "Search 1",
          inputSchema: z.object({}),
          execute: async () => ({}),
        },
        { category: "search" }
      )
      registry.register(
        "search2",
        {
          description: "Search 2",
          inputSchema: z.object({}),
          execute: async () => ({}),
        },
        { category: "search" }
      )
      registry.register(
        "data1",
        {
          description: "Data 1",
          inputSchema: z.object({}),
          execute: async () => ({}),
        },
        { category: "data" }
      )

      const searchTools = registry.getByCategory("search")

      expect(Object.keys(searchTools)).toEqual(["search1", "search2"])
    })

    it("should get safe tools only", () => {
      registry.register(
        "safe",
        {
          description: "Safe tool",
          inputSchema: z.object({}),
          execute: async () => ({}),
        },
        { category: "custom", isDangerous: false }
      )
      registry.register(
        "dangerous",
        {
          description: "Dangerous tool",
          inputSchema: z.object({}),
          execute: async () => ({}),
        },
        { category: "system", isDangerous: true }
      )

      const safeTools = registry.getSafeTools()

      expect(Object.keys(safeTools)).toEqual(["safe"])
    })

    it("should get metadata", () => {
      registry.register(
        "myTool",
        {
          description: "My tool",
          inputSchema: z.object({}),
          execute: async () => ({}),
        },
        {
          category: "custom",
          isDangerous: true,
          rateLimit: 10,
        }
      )

      const metadata = registry.getMetadata("myTool")

      expect(metadata?.name).toBe("myTool")
      expect(metadata?.category).toBe("custom")
      expect(metadata?.isDangerous).toBe(true)
      expect(metadata?.rateLimit).toBe(10)
    })

    it("should get all tool names", () => {
      registry.register(
        "a",
        { description: "A", inputSchema: z.object({}), execute: async () => ({}) },
        { category: "custom" }
      )
      registry.register(
        "b",
        { description: "B", inputSchema: z.object({}), execute: async () => ({}) },
        { category: "custom" }
      )

      expect(registry.getNames()).toEqual(["a", "b"])
    })

    it("should support chained registration", () => {
      const result = registry
        .register(
          "a",
          { description: "A", inputSchema: z.object({}), execute: async () => ({}) },
          { category: "custom" }
        )
        .register(
          "b",
          { description: "B", inputSchema: z.object({}), execute: async () => ({}) },
          { category: "custom" }
        )

      expect(result).toBe(registry)
      expect(registry.getNames()).toHaveLength(2)
    })
  })

  describe("CommonSchemas", () => {
    it("should have URL schema", () => {
      const valid = CommonSchemas.url.safeParse({ url: "https://example.com" })
      const invalid = CommonSchemas.url.safeParse({ url: "not-a-url" })

      expect(valid.success).toBe(true)
      expect(invalid.success).toBe(false)
    })

    it("should have search schema", () => {
      const result = CommonSchemas.search.safeParse({ query: "test", limit: 10 })

      expect(result.success).toBe(true)
    })

    it("should have code schema", () => {
      const result = CommonSchemas.code.safeParse({
        code: 'console.log("hello")',
        language: "javascript",
      })

      expect(result.success).toBe(true)
    })

    it("should have location schema", () => {
      const result = CommonSchemas.location.safeParse({ location: "San Francisco" })

      expect(result.success).toBe(true)
    })
  })

  describe("getDefaultToolRegistry", () => {
    it("should return singleton registry", () => {
      const registry1 = getDefaultToolRegistry()
      const registry2 = getDefaultToolRegistry()

      expect(registry1).toBe(registry2)
    })
  })
})
