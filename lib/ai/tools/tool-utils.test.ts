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
  withRateLimit,
  withCache,
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

    it("passes the schema as v6 `inputSchema`, not the deprecated `parameters`", () => {
      const schema = z.object({ query: z.string() })
      const result = createTool({
        description: "Test tool",
        inputSchema: schema,
        execute: async ({ query }) => ({ result: query }),
      }) as unknown as { inputSchema?: unknown; parameters?: unknown }

      // v6 `tool()` reads the schema off `inputSchema`. If it lands on
      // `parameters` instead, the model gets a tool with no argument schema.
      expect(result.inputSchema).toBe(schema)
      expect(result.parameters).toBeUndefined()
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

    it("should include inputExamples when specified", () => {
      const result = createTool({
        description: "Example tool",
        inputSchema: z.object({ q: z.string() }),
        execute: async () => ({}),
        inputExamples: [{ input: { q: "hello" } }],
      })

      expect((result as unknown as { inputExamples: unknown[] }).inputExamples).toEqual([
        { input: { q: "hello" } },
      ])
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

    it("passes the schema as v6 `inputSchema`, not `parameters`", () => {
      const schema = z.object({ query: z.string() })
      const tools = simpleTool("search", "Search for items", schema, async ({ query }) => [query])
      const t = tools.search as unknown as { inputSchema?: unknown; parameters?: unknown }

      expect(t.inputSchema).toBe(schema)
      expect(t.parameters).toBeUndefined()
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

    it("requiresApproval reflects the isDangerous metadata flag", () => {
      registry.register(
        "danger",
        { description: "d", inputSchema: z.object({}), execute: async () => ({}) },
        { category: "system", isDangerous: true }
      )
      registry.register(
        "safe",
        { description: "s", inputSchema: z.object({}), execute: async () => ({}) },
        { category: "custom" }
      )

      expect(registry.requiresApproval("danger")).toBe(true)
      expect(registry.requiresApproval("safe")).toBe(false)
      // Unknown tools default to not requiring approval.
      expect(registry.requiresApproval("missing")).toBe(false)
    })

    it("getAllMetadata returns metadata for every registered tool", () => {
      registry.register(
        "a",
        { description: "A", inputSchema: z.object({}), execute: async () => ({}) },
        { category: "custom" }
      )
      registry.register(
        "b",
        { description: "B", inputSchema: z.object({}), execute: async () => ({}) },
        { category: "search" }
      )

      const all = registry.getAllMetadata()
      expect(all.map((m) => m.name)).toEqual(["a", "b"])
      expect(all.map((m) => m.category)).toEqual(["custom", "search"])
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

    describe("plugin metadata + lifecycle", () => {
      // Verifies the §A-1 extension: plugins register their tools through the
      // same ToolRegistry as built-in tools, tagged with `source: "plugin"`
      // and `pluginId`. Disabling a plugin must drop only that plugin's tools
      // without touching anything else.

      it("preserves source/pluginId on metadata round-trip", () => {
        registry.register(
          "git_status",
          { description: "git status", inputSchema: z.object({}), execute: async () => ({}) },
          { category: "system", source: "plugin", pluginId: "cognia-git-tools" }
        )

        const meta = registry.getMetadata("git_status")
        expect(meta?.source).toBe("plugin")
        expect(meta?.pluginId).toBe("cognia-git-tools")
      })

      it("treats omitted source/pluginId as builtin (backwards compatibility)", () => {
        registry.register(
          "WebSearch",
          { description: "Built-in", inputSchema: z.object({}), execute: async () => ({}) },
          { category: "search" }
        )

        const meta = registry.getMetadata("WebSearch")
        expect(meta?.source).toBeUndefined()
        expect(meta?.pluginId).toBeUndefined()
      })

      it("unregister(name) removes a single tool and reports success", () => {
        registry.register(
          "victim",
          { description: "v", inputSchema: z.object({}), execute: async () => ({}) },
          { category: "custom" }
        )
        registry.register(
          "survivor",
          { description: "s", inputSchema: z.object({}), execute: async () => ({}) },
          { category: "custom" }
        )

        expect(registry.unregister("victim")).toBe(true)
        expect(registry.get("victim")).toBeUndefined()
        expect(registry.get("survivor")).toBeDefined()
        // Idempotent: a second call returns false because nothing was deleted.
        expect(registry.unregister("victim")).toBe(false)
      })

      it("unregisterByPlugin removes only that plugin's tools", () => {
        registry.register(
          "git_status",
          { description: "g", inputSchema: z.object({}), execute: async () => ({}) },
          { category: "system", source: "plugin", pluginId: "git-tools" }
        )
        registry.register(
          "git_diff",
          { description: "g", inputSchema: z.object({}), execute: async () => ({}) },
          { category: "system", source: "plugin", pluginId: "git-tools" }
        )
        registry.register(
          "shell_exec",
          { description: "s", inputSchema: z.object({}), execute: async () => ({}) },
          { category: "system", source: "plugin", pluginId: "shell-tools" }
        )
        registry.register(
          "WebSearch",
          { description: "w", inputSchema: z.object({}), execute: async () => ({}) },
          { category: "search" } // builtin, no pluginId
        )

        const removed = registry.unregisterByPlugin("git-tools")

        expect(removed).toBe(2)
        expect(registry.get("git_status")).toBeUndefined()
        expect(registry.get("git_diff")).toBeUndefined()
        // Other plugin's tools survive.
        expect(registry.get("shell_exec")).toBeDefined()
        // Builtin tools survive.
        expect(registry.get("WebSearch")).toBeDefined()
      })

      it("unregisterByPlugin returns 0 when no tools match", () => {
        registry.register(
          "WebSearch",
          { description: "w", inputSchema: z.object({}), execute: async () => ({}) },
          { category: "search" }
        )

        expect(registry.unregisterByPlugin("never-installed")).toBe(0)
        expect(registry.get("WebSearch")).toBeDefined()
      })
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

  describe("withRateLimit", () => {
    it("allows calls under the limit and throws once exceeded", async () => {
      const tool = withRateLimit(
        {
          description: "rl",
          inputSchema: z.object({ n: z.number() }),
          execute: async ({ n }) => n * 2,
        },
        { maxCalls: 2, windowMs: 10_000 }
      ) as unknown as { execute: (input: { n: number }) => Promise<number> }

      await expect(tool.execute({ n: 1 })).resolves.toBe(2)
      await expect(tool.execute({ n: 2 })).resolves.toBe(4)
      await expect(tool.execute({ n: 3 })).rejects.toThrow(/Rate limit exceeded/)
    })

    it("evicts calls outside the window so new calls succeed", async () => {
      jest.useFakeTimers().setSystemTime(0)
      try {
        const tool = withRateLimit(
          {
            description: "rl",
            inputSchema: z.object({}),
            execute: async () => "ok",
          },
          { maxCalls: 1, windowMs: 1000 }
        ) as unknown as { execute: (input: Record<string, never>) => Promise<string> }

        await expect(tool.execute({})).resolves.toBe("ok")
        await expect(tool.execute({})).rejects.toThrow(/Rate limit exceeded/)
        // Advance past the window — the earlier call falls out of it.
        jest.setSystemTime(2000)
        await expect(tool.execute({})).resolves.toBe("ok")
      } finally {
        jest.useRealTimers()
      }
    })
  })

  describe("withCache", () => {
    it("returns the cached result on repeated identical input", async () => {
      const execute = jest.fn(async ({ q }: { q: string }) => `result:${q}`)
      const tool = withCache({
        description: "c",
        inputSchema: z.object({ q: z.string() }),
        execute,
      }) as unknown as { execute: (input: { q: string }) => Promise<string> }

      await expect(tool.execute({ q: "x" })).resolves.toBe("result:x")
      await expect(tool.execute({ q: "x" })).resolves.toBe("result:x")
      // Second identical call hits the cache — execute runs only once.
      expect(execute).toHaveBeenCalledTimes(1)
    })

    it("re-executes after the TTL expires", async () => {
      jest.useFakeTimers().setSystemTime(0)
      try {
        const execute = jest.fn(async () => "v")
        const tool = withCache(
          { description: "c", inputSchema: z.object({}), execute },
          { ttlMs: 1000 }
        ) as unknown as { execute: (input: Record<string, never>) => Promise<string> }

        await tool.execute({})
        jest.setSystemTime(2000)
        await tool.execute({})
        expect(execute).toHaveBeenCalledTimes(2)
      } finally {
        jest.useRealTimers()
      }
    })

    it("evicts the oldest entry when capacity is reached", async () => {
      const execute = jest.fn(async ({ q }: { q: string }) => `r:${q}`)
      const tool = withCache(
        {
          description: "c",
          inputSchema: z.object({ q: z.string() }),
          execute,
        },
        { maxSize: 1 }
      ) as unknown as { execute: (input: { q: string }) => Promise<string> }

      await tool.execute({ q: "a" }) // cache: a
      await tool.execute({ q: "b" }) // evicts a, cache: b
      await tool.execute({ q: "a" }) // a was evicted → re-executes
      // a ran twice (initial + after eviction), b ran once.
      expect(execute).toHaveBeenCalledTimes(3)
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
