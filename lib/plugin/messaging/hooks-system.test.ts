/**
 * Plugin Hooks System Tests
 *
 * Tests for:
 * - HookPriority enum and utility functions
 * - Pre/post operation hooks (UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, PostChatReceive)
 */

import {
  HookPriority,
  normalizePriority,
  priorityToNumber,
  priorityToString,
  PluginEventHooks,
  PluginLifecycleHooks,
  HookDispatcher,
  getPluginEventHooks,
  getRecentPluginHookErrors,
  __resetPluginHookErrorsForTesting,
} from "./hooks-system"
import type { PluginTeamStartPayload } from "@/types/plugin"
import type {
  PromptSubmitContext,
  PromptSubmitResult,
  PreToolUseResult,
  PostToolUseResult,
  PreCompactContext,
  PreCompactResult,
  ChatResponseData,
  PostChatReceiveResult,
} from "@/types/plugin/plugin-hooks"

// Mock the plugin store
jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: {
    getState: jest.fn(() => ({
      plugins: {},
    })),
  },
}))

import { usePluginStore } from "@/stores/plugin-runtime"

describe("Plugin Hooks System", () => {
  describe("HookPriority enum", () => {
    it("should have correct values", () => {
      expect(HookPriority.CRITICAL).toBe(100)
      expect(HookPriority.HIGH).toBe(75)
      expect(HookPriority.NORMAL).toBe(50)
      expect(HookPriority.LOW).toBe(25)
      expect(HookPriority.DEFERRED).toBe(0)
    })
  })

  describe("normalizePriority", () => {
    describe("numeric priorities", () => {
      it("should return CRITICAL for values >= 100", () => {
        expect(normalizePriority(100)).toBe(HookPriority.CRITICAL)
        expect(normalizePriority(150)).toBe(HookPriority.CRITICAL)
      })

      it("should return HIGH for values >= 75 and < 100", () => {
        expect(normalizePriority(75)).toBe(HookPriority.HIGH)
        expect(normalizePriority(99)).toBe(HookPriority.HIGH)
      })

      it("should return NORMAL for values >= 50 and < 75", () => {
        expect(normalizePriority(50)).toBe(HookPriority.NORMAL)
        expect(normalizePriority(74)).toBe(HookPriority.NORMAL)
      })

      it("should return LOW for values >= 25 and < 50", () => {
        expect(normalizePriority(25)).toBe(HookPriority.LOW)
        expect(normalizePriority(49)).toBe(HookPriority.LOW)
      })

      it("should return DEFERRED for values < 25", () => {
        expect(normalizePriority(0)).toBe(HookPriority.DEFERRED)
        expect(normalizePriority(24)).toBe(HookPriority.DEFERRED)
      })
    })

    describe("string priorities", () => {
      it('should return CRITICAL for "highest" or "critical"', () => {
        expect(normalizePriority("highest")).toBe(HookPriority.CRITICAL)
        expect(normalizePriority("critical")).toBe(HookPriority.CRITICAL)
        expect(normalizePriority("CRITICAL")).toBe(HookPriority.CRITICAL)
      })

      it('should return HIGH for "high"', () => {
        expect(normalizePriority("high")).toBe(HookPriority.HIGH)
        expect(normalizePriority("HIGH")).toBe(HookPriority.HIGH)
      })

      it('should return NORMAL for "normal"', () => {
        expect(normalizePriority("normal")).toBe(HookPriority.NORMAL)
        expect(normalizePriority("NORMAL")).toBe(HookPriority.NORMAL)
      })

      it('should return LOW for "low"', () => {
        expect(normalizePriority("low")).toBe(HookPriority.LOW)
        expect(normalizePriority("LOW")).toBe(HookPriority.LOW)
      })

      it('should return DEFERRED for "lowest" or "deferred"', () => {
        expect(normalizePriority("lowest")).toBe(HookPriority.DEFERRED)
        expect(normalizePriority("deferred")).toBe(HookPriority.DEFERRED)
      })

      it("should return NORMAL for unknown strings", () => {
        expect(normalizePriority("unknown")).toBe(HookPriority.NORMAL)
        expect(normalizePriority("random")).toBe(HookPriority.NORMAL)
      })
    })
  })

  describe("priorityToNumber", () => {
    it("should return the numeric value of priority", () => {
      expect(priorityToNumber(HookPriority.CRITICAL)).toBe(100)
      expect(priorityToNumber(HookPriority.HIGH)).toBe(75)
      expect(priorityToNumber(HookPriority.NORMAL)).toBe(50)
      expect(priorityToNumber(HookPriority.LOW)).toBe(25)
      expect(priorityToNumber(HookPriority.DEFERRED)).toBe(0)
    })
  })

  describe("priorityToString", () => {
    it('should return "high" for CRITICAL', () => {
      expect(priorityToString(HookPriority.CRITICAL)).toBe("high")
    })

    it('should return "high" for HIGH', () => {
      expect(priorityToString(HookPriority.HIGH)).toBe("high")
    })

    it('should return "normal" for NORMAL', () => {
      expect(priorityToString(HookPriority.NORMAL)).toBe("normal")
    })

    it('should return "low" for LOW', () => {
      expect(priorityToString(HookPriority.LOW)).toBe("low")
    })

    it('should return "low" for DEFERRED', () => {
      expect(priorityToString(HookPriority.DEFERRED)).toBe("low")
    })
  })
})

describe("Chat Hook System", () => {
  let hooks: PluginEventHooks

  beforeEach(() => {
    hooks = getPluginEventHooks()
    jest.clearAllMocks()
  })

  describe("dispatchUserPromptSubmit", () => {
    it("should return proceed action when no plugins are registered", async () => {
      const context: PromptSubmitContext = {
        mode: "chat",
        previousMessages: [],
      }

      const result = await hooks.dispatchUserPromptSubmit("Hello", "session-1", context)

      expect(result.action).toBe("proceed")
    })

    it("should have correct result type structure", async () => {
      const context: PromptSubmitContext = {
        mode: "agent",
        previousMessages: [{ id: "1", role: "user", content: "Previous message" }],
        attachments: [{ id: "att-1", name: "file.txt", type: "file" }],
      }

      const result = await hooks.dispatchUserPromptSubmit("Test prompt", "session-1", context)

      expect(result).toHaveProperty("action")
      expect(["proceed", "block", "modify"]).toContain(result.action)
    })
  })

  describe("dispatchPreToolUse", () => {
    it("should return allow action when no plugins are registered", async () => {
      const result = await hooks.dispatchPreToolUse("testTool", { arg1: "value" }, "session-1")

      expect(result.action).toBe("allow")
    })

    it("should have correct result type structure", async () => {
      const result = await hooks.dispatchPreToolUse(
        "searchFiles",
        { query: "test", path: "/src" },
        "agent-123"
      )

      expect(result).toHaveProperty("action")
      expect(["allow", "deny", "modify"]).toContain(result.action)
    })
  })

  describe("dispatchPostToolUse", () => {
    it("should return empty result when no plugins are registered", async () => {
      const result = await hooks.dispatchPostToolUse(
        "testTool",
        { arg1: "value" },
        { success: true, data: "result" },
        "session-1"
      )

      expect(result).toEqual({})
    })

    it("should handle tool result with optional modifications", async () => {
      const toolResult = {
        files: ["file1.ts", "file2.ts"],
        count: 2,
      }

      const result = await hooks.dispatchPostToolUse(
        "listFiles",
        { directory: "/src" },
        toolResult,
        "agent-456"
      )

      expect(typeof result).toBe("object")
      if (result.modifiedResult !== undefined) {
        expect(result.modifiedResult).toBeDefined()
      }
      if (result.additionalMessages) {
        expect(Array.isArray(result.additionalMessages)).toBe(true)
      }
    })
  })

  describe("dispatchPreCompact", () => {
    it("should return empty result when no plugins are registered", async () => {
      const context: PreCompactContext = {
        sessionId: "session-1",
        messageCount: 50,
        tokenCount: 8000,
        compressionRatio: 0.8,
      }

      const result = await hooks.dispatchPreCompact(context)

      expect(result).toEqual({})
    })

    it("should handle compression context properly", async () => {
      const context: PreCompactContext = {
        sessionId: "long-session",
        messageCount: 100,
        tokenCount: 15000,
        compressionRatio: 1.2,
      }

      const result = await hooks.dispatchPreCompact(context)

      expect(typeof result).toBe("object")
      if (result.skipCompaction !== undefined) {
        expect(typeof result.skipCompaction).toBe("boolean")
      }
      if (result.contextToInject !== undefined) {
        expect(typeof result.contextToInject).toBe("string")
      }
      if (result.customStrategy !== undefined) {
        expect(["aggressive", "moderate", "minimal"]).toContain(result.customStrategy)
      }
    })
  })

  describe("dispatchPostChatReceive", () => {
    it("should return empty result when no plugins are registered", async () => {
      const response: ChatResponseData = {
        content: "AI response content",
        messageId: "msg-123",
        sessionId: "session-1",
        model: "gpt-4",
        provider: "openai",
      }

      const result = await hooks.dispatchPostChatReceive(response)

      expect(result).toEqual({})
    })

    it("should handle response data with all fields", async () => {
      const response: ChatResponseData = {
        content: "Here is a detailed analysis of the code...",
        messageId: "msg-456",
        sessionId: "session-2",
        model: "claude-3-sonnet",
        provider: "anthropic",
      }

      const result = await hooks.dispatchPostChatReceive(response)

      expect(typeof result).toBe("object")
      if (result.modifiedContent !== undefined) {
        expect(typeof result.modifiedContent).toBe("string")
      }
      if (result.additionalMessages) {
        expect(Array.isArray(result.additionalMessages)).toBe(true)
      }
      if (result.metadata) {
        expect(typeof result.metadata).toBe("object")
      }
    })
  })
})

describe("PluginLifecycleHooks - New Dispatchers", () => {
  let lifecycleHooks: PluginLifecycleHooks

  beforeEach(() => {
    lifecycleHooks = new PluginLifecycleHooks()
  })

  describe("Message Lifecycle Hooks", () => {
    it("dispatchOnMessageDelete should call registered hooks", () => {
      const onMessageDelete = jest.fn()
      lifecycleHooks.registerHooks("test-plugin", { onMessageDelete })
      lifecycleHooks.dispatchOnMessageDelete("msg-1", "session-1")
      expect(onMessageDelete).toHaveBeenCalledWith("msg-1", "session-1")
    })

    it("dispatchOnMessageEdit should call registered hooks", () => {
      const onMessageEdit = jest.fn()
      lifecycleHooks.registerHooks("test-plugin", { onMessageEdit })
      lifecycleHooks.dispatchOnMessageEdit("msg-1", "old text", "new text", "session-1")
      expect(onMessageEdit).toHaveBeenCalledWith("msg-1", "old text", "new text", "session-1")
    })

    it("dispatchOnMessageDelete should handle errors gracefully", () => {
      const onMessageDelete = jest.fn(() => {
        throw new Error("test error")
      })
      lifecycleHooks.registerHooks("test-plugin", { onMessageDelete })
      expect(() => lifecycleHooks.dispatchOnMessageDelete("msg-1", "session-1")).not.toThrow()
    })
  })

  describe("Session Lifecycle Extended Hooks", () => {
    it("dispatchOnSessionRename should call registered hooks", () => {
      const onSessionRename = jest.fn()
      lifecycleHooks.registerHooks("test-plugin", { onSessionRename })
      lifecycleHooks.dispatchOnSessionRename("session-1", "Old Title", "New Title")
      expect(onSessionRename).toHaveBeenCalledWith("session-1", "Old Title", "New Title")
    })

    it("dispatchOnSessionClear should call registered hooks", () => {
      const onSessionClear = jest.fn()
      lifecycleHooks.registerHooks("test-plugin", { onSessionClear })
      lifecycleHooks.dispatchOnSessionClear("session-1")
      expect(onSessionClear).toHaveBeenCalledWith("session-1")
    })
  })

  describe("Chat Flow Hooks", () => {
    it("dispatchOnChatRegenerate should call registered hooks", () => {
      const onChatRegenerate = jest.fn()
      lifecycleHooks.registerHooks("test-plugin", { onChatRegenerate })
      lifecycleHooks.dispatchOnChatRegenerate("msg-1", "session-1")
      expect(onChatRegenerate).toHaveBeenCalledWith("msg-1", "session-1")
    })

    it("dispatchOnModelSwitch should call registered hooks", () => {
      const onModelSwitch = jest.fn()
      lifecycleHooks.registerHooks("test-plugin", { onModelSwitch })
      lifecycleHooks.dispatchOnModelSwitch("anthropic", "claude-3", "openai", "gpt-4o")
      expect(onModelSwitch).toHaveBeenCalledWith("anthropic", "claude-3", "openai", "gpt-4o")
    })

    it("dispatchOnChatModeSwitch should call registered hooks", () => {
      const onChatModeSwitch = jest.fn()
      lifecycleHooks.registerHooks("test-plugin", { onChatModeSwitch })
      lifecycleHooks.dispatchOnChatModeSwitch("session-1", "agent", "chat")
      expect(onChatModeSwitch).toHaveBeenCalledWith("session-1", "agent", "chat")
    })

    it("dispatchOnSystemPromptChange should call registered hooks", () => {
      const onSystemPromptChange = jest.fn()
      lifecycleHooks.registerHooks("test-plugin", { onSystemPromptChange })
      lifecycleHooks.dispatchOnSystemPromptChange("session-1", "new prompt", "old prompt")
      expect(onSystemPromptChange).toHaveBeenCalledWith("session-1", "new prompt", "old prompt")
    })
  })

  describe("Agent Plan Hooks", () => {
    it("dispatchOnAgentPlanCreate should call registered hooks", () => {
      const onAgentPlanCreate = jest.fn()
      lifecycleHooks.registerHooks("test-plugin", { onAgentPlanCreate })
      const tasks = [{ id: "task-1", description: "Do something" }]
      lifecycleHooks.dispatchOnAgentPlanCreate("agent-1", tasks)
      expect(onAgentPlanCreate).toHaveBeenCalledWith("agent-1", tasks)
    })

    it("dispatchOnAgentPlanStepComplete should call registered hooks", () => {
      const onAgentPlanStepComplete = jest.fn()
      lifecycleHooks.registerHooks("test-plugin", { onAgentPlanStepComplete })
      lifecycleHooks.dispatchOnAgentPlanStepComplete("agent-1", "task-1", "result data", true)
      expect(onAgentPlanStepComplete).toHaveBeenCalledWith("agent-1", "task-1", "result data", true)
    })

    it("dispatchOnAgentPlanStepComplete should handle failed steps", () => {
      const onAgentPlanStepComplete = jest.fn()
      lifecycleHooks.registerHooks("test-plugin", { onAgentPlanStepComplete })
      lifecycleHooks.dispatchOnAgentPlanStepComplete("agent-1", "task-2", "error msg", false)
      expect(onAgentPlanStepComplete).toHaveBeenCalledWith("agent-1", "task-2", "error msg", false)
    })
  })

  describe("Scheduler Hooks", () => {
    it("dispatchOnScheduledTaskStart should call registered hooks", () => {
      const onScheduledTaskStart = jest.fn()
      lifecycleHooks.registerHooks("test-plugin", { onScheduledTaskStart })
      lifecycleHooks.dispatchOnScheduledTaskStart("task-1", "exec-1")
      expect(onScheduledTaskStart).toHaveBeenCalledWith("task-1", "exec-1")
    })

    it("dispatchOnScheduledTaskComplete should call registered hooks", () => {
      const onScheduledTaskComplete = jest.fn()
      lifecycleHooks.registerHooks("test-plugin", { onScheduledTaskComplete })
      const result = { success: true, output: { data: "test" } }
      lifecycleHooks.dispatchOnScheduledTaskComplete("task-1", "exec-1", result)
      expect(onScheduledTaskComplete).toHaveBeenCalledWith("task-1", "exec-1", result)
    })

    it("dispatchOnScheduledTaskError should call registered hooks", () => {
      const onScheduledTaskError = jest.fn()
      lifecycleHooks.registerHooks("test-plugin", { onScheduledTaskError })
      const error = new Error("Task failed")
      lifecycleHooks.dispatchOnScheduledTaskError("task-1", "exec-1", error)
      expect(onScheduledTaskError).toHaveBeenCalledWith("task-1", "exec-1", error)
    })
  })

  describe("Multiple plugins", () => {
    it("should dispatch to all registered plugins in order", () => {
      const calls: string[] = []
      lifecycleHooks.registerHooks("plugin-a", {
        onChatRegenerate: () => calls.push("a"),
      })
      lifecycleHooks.registerHooks("plugin-b", {
        onChatRegenerate: () => calls.push("b"),
      })
      lifecycleHooks.dispatchOnChatRegenerate("msg-1", "session-1")
      expect(calls).toEqual(["a", "b"])
    })

    it("should continue dispatching if one plugin throws", () => {
      const calls: string[] = []
      lifecycleHooks.registerHooks("plugin-a", {
        onModelSwitch: () => {
          throw new Error("fail")
        },
      })
      lifecycleHooks.registerHooks("plugin-b", {
        onModelSwitch: () => calls.push("b"),
      })
      lifecycleHooks.dispatchOnModelSwitch("openai", "gpt-4o")
      expect(calls).toEqual(["b"])
    })
  })
})

describe("Hook Type Definitions", () => {
  it("should have valid PromptSubmitResult structure", () => {
    const proceed: PromptSubmitResult = { action: "proceed" }
    const block: PromptSubmitResult = { action: "block", blockReason: "Not allowed" }
    const modify: PromptSubmitResult = {
      action: "modify",
      modifiedPrompt: "Enhanced prompt",
      additionalContext: "Extra context",
    }

    expect(proceed.action).toBe("proceed")
    expect(block.blockReason).toBe("Not allowed")
    expect(modify.modifiedPrompt).toBe("Enhanced prompt")
  })

  it("should have valid PreToolUseResult structure", () => {
    const allow: PreToolUseResult = { action: "allow" }
    const deny: PreToolUseResult = { action: "deny", denyReason: "Unsafe operation" }
    const modify: PreToolUseResult = {
      action: "modify",
      modifiedArgs: { sanitized: true, input: "safe-value" },
    }

    expect(allow.action).toBe("allow")
    expect(deny.denyReason).toBe("Unsafe operation")
    expect(modify.modifiedArgs).toEqual({ sanitized: true, input: "safe-value" })
  })

  it("should have valid PostToolUseResult structure", () => {
    const empty: PostToolUseResult = {}
    const withModified: PostToolUseResult = {
      modifiedResult: { enhanced: true, data: "modified" },
    }
    const withMessages: PostToolUseResult = {
      additionalMessages: [
        { id: "msg-1", role: "assistant", content: "Tool executed successfully" },
      ],
    }

    expect(empty).toEqual({})
    expect(withModified.modifiedResult).toEqual({ enhanced: true, data: "modified" })
    expect(withMessages.additionalMessages).toHaveLength(1)
  })

  it("should have valid PreCompactResult structure", () => {
    const empty: PreCompactResult = {}
    const skip: PreCompactResult = { skipCompaction: true }
    const custom: PreCompactResult = {
      customStrategy: "aggressive",
      contextToInject: "Important context to preserve",
    }

    expect(empty).toEqual({})
    expect(skip.skipCompaction).toBe(true)
    expect(custom.customStrategy).toBe("aggressive")
  })

  it("should have valid PostChatReceiveResult structure", () => {
    const empty: PostChatReceiveResult = {}
    const withModified: PostChatReceiveResult = {
      modifiedContent: "Enhanced response with formatting",
    }
    const full: PostChatReceiveResult = {
      modifiedContent: "Modified content",
      additionalMessages: [{ id: "follow-up", role: "assistant", content: "Follow-up note" }],
      metadata: { analyzed: true, sentiment: "positive" },
    }

    expect(empty).toEqual({})
    expect(withModified.modifiedContent).toBe("Enhanced response with formatting")
    expect(full.additionalMessages).toHaveLength(1)
    expect(full.metadata).toHaveProperty("sentiment", "positive")
  })
})

describe("PluginEventHooks - timeout and new dispatchers", () => {
  let eventHooks: PluginEventHooks
  const { usePluginStore } = jest.requireMock("@/stores/plugin-runtime")

  beforeEach(() => {
    eventHooks = new PluginEventHooks()
    jest.clearAllMocks()
  })

  describe("executeHook timeout", () => {
    it("should not crash when hooks throw errors", () => {
      usePluginStore.getState.mockReturnValue({
        plugins: {
          "error-plugin": {
            status: "enabled",
            hooks: {
              onCodeExecutionStart: () => {
                throw new Error("hook crash")
              },
            },
          },
        },
      })

      // Should not throw - errors are caught by executeHook
      expect(() => {
        eventHooks.dispatchCodeExecutionStart("python", 'print("hi")')
      }).not.toThrow()
    })

    it("should handle hooks that complete before timeout", async () => {
      const handler = jest.fn()
      usePluginStore.getState.mockReturnValue({
        plugins: {
          "fast-plugin": {
            status: "enabled",
            hooks: { onCodeExecutionComplete: handler },
          },
        },
      })

      eventHooks.dispatchCodeExecutionComplete("python", { output: "hello" })

      // Should have called the handler
      expect(handler).toHaveBeenCalledWith("python", { output: "hello" }, undefined)
    })
  })

  describe("Code Execution dispatchers", () => {
    it("should dispatch onCodeExecutionStart", () => {
      const handler = jest.fn()
      usePluginStore.getState.mockReturnValue({
        plugins: {
          "test-plugin": {
            status: "enabled",
            hooks: { onCodeExecutionStart: handler },
          },
        },
      })

      eventHooks.dispatchCodeExecutionStart("javascript", 'console.log("hi")', "sandbox-1")
      expect(handler).toHaveBeenCalledWith("javascript", 'console.log("hi")', "sandbox-1")
    })

    it("should dispatch onCodeExecutionError", () => {
      const handler = jest.fn()
      usePluginStore.getState.mockReturnValue({
        plugins: {
          "test-plugin": {
            status: "enabled",
            hooks: { onCodeExecutionError: handler },
          },
        },
      })

      const error = new Error("Syntax error")
      eventHooks.dispatchCodeExecutionError("python", error, "sandbox-2")
      expect(handler).toHaveBeenCalledWith("python", error, "sandbox-2")
    })
  })

  describe("MCP Server dispatchers", () => {
    it("should dispatch onMCPServerConnect", () => {
      const handler = jest.fn()
      usePluginStore.getState.mockReturnValue({
        plugins: {
          "test-plugin": {
            status: "enabled",
            hooks: { onMCPServerConnect: handler },
          },
        },
      })

      eventHooks.dispatchMCPServerConnect("server-1", "My MCP Server")
      expect(handler).toHaveBeenCalledWith("server-1", "My MCP Server")
    })

    it("should dispatch onMCPServerDisconnect", () => {
      const handler = jest.fn()
      usePluginStore.getState.mockReturnValue({
        plugins: {
          "test-plugin": {
            status: "enabled",
            hooks: { onMCPServerDisconnect: handler },
          },
        },
      })

      eventHooks.dispatchMCPServerDisconnect("server-1")
      expect(handler).toHaveBeenCalledWith("server-1")
    })

    it("should dispatch onMCPToolCall", () => {
      const handler = jest.fn()
      usePluginStore.getState.mockReturnValue({
        plugins: {
          "test-plugin": {
            status: "enabled",
            hooks: { onMCPToolCall: handler },
          },
        },
      })

      eventHooks.dispatchMCPToolCall("server-1", "read_file", { path: "/tmp/test.txt" })
      expect(handler).toHaveBeenCalledWith("server-1", "read_file", { path: "/tmp/test.txt" })
    })

    it("should dispatch onMCPToolResult", () => {
      const handler = jest.fn()
      usePluginStore.getState.mockReturnValue({
        plugins: {
          "test-plugin": {
            status: "enabled",
            hooks: { onMCPToolResult: handler },
          },
        },
      })

      eventHooks.dispatchMCPToolResult("server-1", "read_file", { content: "file data" })
      expect(handler).toHaveBeenCalledWith("server-1", "read_file", { content: "file data" })
    })

    it("should skip disabled plugins", () => {
      const handler = jest.fn()
      usePluginStore.getState.mockReturnValue({
        plugins: {
          "disabled-plugin": {
            status: "disabled",
            hooks: { onMCPToolCall: handler },
          },
        },
      })

      eventHooks.dispatchMCPToolCall("server-1", "tool", {})
      expect(handler).not.toHaveBeenCalled()
    })

    it("should handle plugin errors gracefully", () => {
      usePluginStore.getState.mockReturnValue({
        plugins: {
          "error-plugin": {
            status: "enabled",
            hooks: {
              onMCPServerConnect: () => {
                throw new Error("Plugin crash")
              },
            },
          },
        },
      })

      // Should not throw - errors are caught internally
      expect(() => {
        eventHooks.dispatchMCPServerConnect("server-1", "Test")
      }).not.toThrow()
    })
  })

  describe("Terminal dispatchers", () => {
    const baseReq = {
      shell: "/bin/bash",
      rows: 24,
      cols: 80,
      projectId: "proj-a",
    } as const

    it("returns allow + original req when no plugins are registered", async () => {
      usePluginStore.getState.mockReturnValue({ plugins: {} })
      const out = await eventHooks.dispatchTerminalWillSpawn({ ...baseReq })
      expect(out.decision).toBe("allow")
      expect(out.req).toEqual({ ...baseReq })
    })

    it("returns allow when the only subscriber returns 'allow'", async () => {
      usePluginStore.getState.mockReturnValue({
        plugins: {
          "allow-plugin": {
            status: "enabled",
            hooks: { onTerminalWillSpawn: () => "allow" as const },
          },
        },
      })
      const out = await eventHooks.dispatchTerminalWillSpawn({ ...baseReq })
      expect(out.decision).toBe("allow")
    })

    it("short-circuits to deny when any subscriber returns 'deny'", async () => {
      usePluginStore.getState.mockReturnValue({
        plugins: {
          "deny-plugin": {
            status: "enabled",
            hooks: { onTerminalWillSpawn: () => "deny" as const },
          },
        },
      })
      const out = await eventHooks.dispatchTerminalWillSpawn({ ...baseReq })
      expect(out.decision).toBe("deny")
    })

    it("merges mutations from a subscriber into the resolved request", async () => {
      usePluginStore.getState.mockReturnValue({
        plugins: {
          mutator: {
            status: "enabled",
            hooks: {
              onTerminalWillSpawn: () => ({
                ...baseReq,
                shell: "/usr/local/bin/fish",
                cwd: "/tmp/forced",
              }),
            },
          },
        },
      })
      const out = await eventHooks.dispatchTerminalWillSpawn({ ...baseReq })
      expect(out.decision).toBe("allow")
      expect(out.req.shell).toBe("/usr/local/bin/fish")
      expect(out.req.cwd).toBe("/tmp/forced")
    })

    it("treats undefined / void returns as allow", async () => {
      usePluginStore.getState.mockReturnValue({
        plugins: {
          silent: {
            status: "enabled",
            hooks: { onTerminalWillSpawn: () => undefined },
          },
        },
      })
      const out = await eventHooks.dispatchTerminalWillSpawn({ ...baseReq })
      expect(out.decision).toBe("allow")
    })

    it("treats hook errors as allow (never wedges the dock)", async () => {
      usePluginStore.getState.mockReturnValue({
        plugins: {
          buggy: {
            status: "enabled",
            hooks: {
              onTerminalWillSpawn: () => {
                throw new Error("boom")
              },
            },
          },
        },
      })
      const out = await eventHooks.dispatchTerminalWillSpawn({ ...baseReq })
      expect(out.decision).toBe("allow")
    })

    it("dispatchTerminalLifecycle fans out without blocking", () => {
      const handler = jest.fn()
      usePluginStore.getState.mockReturnValue({
        plugins: {
          audit: {
            status: "enabled",
            hooks: { onTerminalLifecycle: handler },
          },
        },
      })
      eventHooks.dispatchTerminalLifecycle({
        kind: "spawned",
        sessionId: "sess-1",
        projectId: "proj-a",
      })
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "spawned", sessionId: "sess-1" })
      )
    })
  })
})

describe("HookDispatcher deterministic ordering", () => {
  function registerAll(
    dispatcher: HookDispatcher,
    hookName: string,
    entries: Array<{ pluginId: string; priority?: HookPriority; handler: () => void }>
  ) {
    for (const entry of entries) {
      dispatcher.registerHook(hookName, entry.pluginId, entry.handler, {
        priority: entry.priority || HookPriority.NORMAL,
      })
    }
  }

  function shuffled<T>(input: T[], seed: number): T[] {
    const out = [...input]
    let s = seed
    const rand = () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 0x100000000
    }
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
  }

  type Family = {
    name: string
    hook: string
    plugins: Array<{ pluginId: string; priority?: HookPriority }>
    expected: string[]
  }

  const families: Family[] = [
    {
      name: "lifecycle",
      hook: "onLoad",
      plugins: [
        { pluginId: "zeta-plugin", priority: HookPriority.NORMAL },
        { pluginId: "alpha-plugin", priority: HookPriority.NORMAL },
        { pluginId: "beta-plugin", priority: HookPriority.HIGH },
      ],
      expected: ["beta-plugin", "alpha-plugin", "zeta-plugin"],
    },
    {
      name: "chat",
      hook: "onMessageSend",
      plugins: [
        { pluginId: "plugin-m", priority: HookPriority.LOW },
        { pluginId: "plugin-a", priority: HookPriority.HIGH },
        { pluginId: "plugin-z", priority: HookPriority.HIGH },
      ],
      expected: ["plugin-a", "plugin-z", "plugin-m"],
    },
    {
      name: "canvas",
      hook: "onCanvasCreate",
      plugins: [
        { pluginId: "canvas-b", priority: HookPriority.NORMAL },
        { pluginId: "canvas-a", priority: HookPriority.NORMAL },
      ],
      expected: ["canvas-a", "canvas-b"],
    },
    {
      name: "agent",
      hook: "onAgentStart",
      plugins: [
        { pluginId: "agent-c", priority: HookPriority.CRITICAL },
        { pluginId: "agent-a", priority: HookPriority.NORMAL },
        { pluginId: "agent-b", priority: HookPriority.CRITICAL },
      ],
      expected: ["agent-b", "agent-c", "agent-a"],
    },
    {
      name: "workflow",
      hook: "onWorkflowStart",
      plugins: [
        { pluginId: "wf-2", priority: HookPriority.NORMAL },
        { pluginId: "wf-1", priority: HookPriority.NORMAL },
        { pluginId: "wf-3", priority: HookPriority.LOW },
      ],
      expected: ["wf-1", "wf-2", "wf-3"],
    },
  ]

  for (const family of families) {
    it(`dispatches ${family.name} hooks in priority-then-id order across randomized registration`, async () => {
      const firstRun: string[] = []
      const firstDispatcher = new HookDispatcher()
      registerAll(
        firstDispatcher,
        family.hook,
        shuffled(family.plugins, 42).map((p) => ({
          ...p,
          handler: () => firstRun.push(p.pluginId),
        }))
      )
      await firstDispatcher.executeHook(family.hook, [])
      expect(firstRun).toEqual(family.expected)

      const secondRun: string[] = []
      const secondDispatcher = new HookDispatcher()
      registerAll(
        secondDispatcher,
        family.hook,
        shuffled(family.plugins, 9001).map((p) => ({
          ...p,
          handler: () => secondRun.push(p.pluginId),
        }))
      )
      await secondDispatcher.executeHook(family.hook, [])
      expect(secondRun).toEqual(family.expected)
      expect(secondRun).toEqual(firstRun)
    })
  }
})

describe("PluginLifecycleHooks - Team hook isolation (fire-and-forget)", () => {
  const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))

  const payload: PluginTeamStartPayload = {
    teamId: "team-1",
    runId: "run-1",
    workers: [{ id: "lead", name: "Lead", role: "lead" }],
    taskCount: 1,
  }

  beforeEach(() => {
    __resetPluginHookErrorsForTesting()
  })

  it("defers handler execution to a microtask (does not run synchronously)", async () => {
    const hooks = new PluginLifecycleHooks()
    const onTeamStart = jest.fn()
    hooks.registerHooks("p-defer", { onTeamStart })

    hooks.dispatchOnTeamStart(payload)
    expect(onTeamStart).not.toHaveBeenCalled() // queued, not yet run

    await flushMicrotasks()
    expect(onTeamStart).toHaveBeenCalledWith(payload)
  })

  it("isolates a throwing plugin so siblings on the same hook still run", async () => {
    const hooks = new PluginLifecycleHooks()
    const good = jest.fn()
    const bad = jest.fn(() => {
      throw new Error("plugin blew up")
    })
    hooks.registerHooks("p-bad", { onTeamStart: bad })
    hooks.registerHooks("p-good", { onTeamStart: good })

    hooks.dispatchOnTeamStart(payload)
    await flushMicrotasks()

    expect(bad).toHaveBeenCalledTimes(1)
    expect(good).toHaveBeenCalledTimes(1)

    const errors = getRecentPluginHookErrors()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      pluginId: "p-bad",
      hookName: "onTeamStart",
      message: "plugin blew up",
    })
  })

  it("caps the error ring buffer at 256 records", async () => {
    const hooks = new PluginLifecycleHooks()
    hooks.registerHooks("p-spam", {
      onTeamStart: () => {
        throw new Error("boom")
      },
    })
    for (let i = 0; i < 300; i += 1) {
      hooks.dispatchOnTeamStart(payload)
    }
    await flushMicrotasks()
    expect(getRecentPluginHookErrors().length).toBe(256)
  })
})

describe("PluginEventHooks - Workflow Node + Trigger Hooks", () => {
  const hooks = getPluginEventHooks()
  const getState = usePluginStore.getState as jest.Mock

  function withHook(hookName: string, fn: jest.Mock) {
    getState.mockReturnValue({
      plugins: { "test-plugin": { status: "enabled", hooks: { [hookName]: fn } } },
    })
  }

  afterEach(() => {
    getState.mockReturnValue({ plugins: {} })
  })

  it("dispatchWorkflowNodeStart calls the enabled plugin's hook", () => {
    const fn = jest.fn()
    withHook("onWorkflowNodeStart", fn)
    hooks.dispatchWorkflowNodeStart("wf", "n1", "ai.prompt")
    expect(fn).toHaveBeenCalledWith("wf", "n1", "ai.prompt")
  })

  it("dispatchWorkflowNodeComplete calls the enabled plugin's hook", () => {
    const fn = jest.fn()
    withHook("onWorkflowNodeComplete", fn)
    hooks.dispatchWorkflowNodeComplete("wf", "n1", "ai.prompt", { ok: true })
    expect(fn).toHaveBeenCalledWith("wf", "n1", "ai.prompt", { ok: true })
  })

  it("dispatchWorkflowNodeError calls the enabled plugin's hook", () => {
    const fn = jest.fn()
    const err = new Error("boom")
    withHook("onWorkflowNodeError", fn)
    hooks.dispatchWorkflowNodeError("wf", "n1", err)
    expect(fn).toHaveBeenCalledWith("wf", "n1", err)
  })

  it("dispatchWorkflowTriggerFired calls the enabled plugin's hook", () => {
    const fn = jest.fn()
    withHook("onWorkflowTriggerFired", fn)
    hooks.dispatchWorkflowTriggerFired("wf", "trigger.cron", { at: 1 })
    expect(fn).toHaveBeenCalledWith("wf", "trigger.cron", { at: 1 })
  })
})
