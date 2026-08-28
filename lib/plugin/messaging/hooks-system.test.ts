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
import {
  registerPluginHookContribution,
  __resetHookRegistryForTesting,
} from "@/lib/plugin/registries/hook-registry"
/**
 * Seed the plugin runtime for a dispatch test.
 *
 * Hooks now live in ONE place (`lib/plugin/registries/hook-registry.ts`) rather
 * than being written to the Zustand store and a class-private Map and read
 * apart. The store mock still supplies each plugin's `status`, because that is
 * where enablement genuinely lives and the registry reads it rather than
 * mirroring it.
 */
function seedPlugins(state: {
  plugins: Record<string, { status?: string; hooks?: unknown } | undefined>
}) {
  const getState = usePluginStore.getState as unknown as jest.Mock
  getState.mockReturnValue(state)
  __resetHookRegistryForTesting()
  for (const [pluginId, row] of Object.entries(state.plugins)) {
    if (row?.hooks) {
      registerPluginHookContribution(pluginId, row.hooks as never)
    }
  }
}

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

describe("hasAnyHook predicates", () => {
  describe("PluginEventHooks.hasAnyHook", () => {
    let eventHooks: PluginEventHooks

    beforeEach(() => {
      eventHooks = getPluginEventHooks()
      jest.clearAllMocks()
      seedPlugins({ plugins: {} })
    })

    it("is false when no plugin contributes the hook", () => {
      expect(eventHooks.hasAnyHook("onUserPromptSubmit")).toBe(false)
    })

    it("is true when an enabled plugin contributes the hook", () => {
      seedPlugins({
        plugins: { p1: { status: "enabled", hooks: { onUserPromptSubmit: jest.fn() } } },
      })
      expect(eventHooks.hasAnyHook("onUserPromptSubmit")).toBe(true)
      // A different, unregistered hook name stays false.
      expect(eventHooks.hasAnyHook("onPreToolUse")).toBe(false)
    })

    it("ignores disabled plugins (enabled-only, matching the dispatch path)", () => {
      seedPlugins({
        plugins: { p1: { status: "disabled", hooks: { onUserPromptSubmit: jest.fn() } } },
      })
      expect(eventHooks.hasAnyHook("onUserPromptSubmit")).toBe(false)
    })
  })

  describe("PluginLifecycleHooks.hasAnyHook", () => {
    let lifecycleHooks: PluginLifecycleHooks

    beforeEach(() => {
      lifecycleHooks = new PluginLifecycleHooks()
      // Reset the shared runtime: `hasAnyHook` is now enabled-filtered (it
      // gates dispatch, and dispatch respects enablement), so a plugin row
      // left "disabled" by a previous test would suppress the registration
      // this test makes.
      seedPlugins({ plugins: {} })
    })

    it("is false before any registration", () => {
      expect(lifecycleHooks.hasAnyHook("onMessageReceive")).toBe(false)
    })

    it("is true once a plugin registers the hook, false for others", () => {
      lifecycleHooks.registerHooks("p1", { onMessageReceive: (m) => m })
      expect(lifecycleHooks.hasAnyHook("onMessageReceive")).toBe(true)
      expect(lifecycleHooks.hasAnyHook("onEnable")).toBe(false)
    })

    it("returns false after the contributing plugin unregisters", () => {
      lifecycleHooks.registerHooks("p1", { onMessageReceive: (m) => m })
      lifecycleHooks.unregisterHooks("p1")
      expect(lifecycleHooks.hasAnyHook("onMessageReceive")).toBe(false)
    })

    it("ignores a registered-but-disabled plugin, like the dispatch path", () => {
      // Previously this dispatcher had NO enabled check while the event
      // dispatcher did, so a disabled plugin kept receiving fan-out hooks from
      // one of the two and not the other. One registry, one rule.
      // Seed FIRST: `seedPlugins` resets the registry, so registering before it
      // would make this pass because the hook vanished, not because the plugin
      // is disabled.
      seedPlugins({ plugins: { p1: { status: "disabled" } } })
      lifecycleHooks.registerHooks("p1", { onMessageReceive: (m) => m })
      expect(lifecycleHooks.hasAnyHook("onMessageReceive")).toBe(false)

      // Same registration, enabled ⇒ visible. Proves the status is what moved.
      seedPlugins({ plugins: { p1: { status: "enabled" } } })
      lifecycleHooks.registerHooks("p1", { onMessageReceive: (m) => m })
      expect(lifecycleHooks.hasAnyHook("onMessageReceive")).toBe(true)
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

  describe("getHooksByPlugin", () => {
    it("returns the hook names a plugin registered", () => {
      lifecycleHooks.registerHooks("p1", { onEnable: jest.fn(), onDisable: jest.fn() })
      const names = lifecycleHooks.getHooksByPlugin("p1")
      expect(names).toEqual(expect.arrayContaining(["onEnable", "onDisable"]))
      expect(names).toHaveLength(2)
    })

    it("returns an empty array for an unregistered plugin", () => {
      expect(lifecycleHooks.getHooksByPlugin("missing")).toEqual([])
    })

    it("ignores hook keys explicitly set to undefined", () => {
      lifecycleHooks.registerHooks("p2", { onEnable: jest.fn(), onDisable: undefined })
      expect(lifecycleHooks.getHooksByPlugin("p2")).toEqual(["onEnable"])
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

  describe("Lifecycle Stage Hooks", () => {
    it("dispatchOnEnable should call the registered onEnable hook", async () => {
      const onEnable = jest.fn()
      lifecycleHooks.registerHooks("test-plugin", { onEnable })
      await lifecycleHooks.dispatchOnEnable("test-plugin")
      expect(onEnable).toHaveBeenCalledTimes(1)
    })

    it("dispatchOnDisable should call the registered onDisable hook", async () => {
      const onDisable = jest.fn()
      lifecycleHooks.registerHooks("test-plugin", { onDisable })
      await lifecycleHooks.dispatchOnDisable("test-plugin")
      expect(onDisable).toHaveBeenCalledTimes(1)
    })

    it("dispatchOnUnload should call the registered onUnload hook", async () => {
      const onUnload = jest.fn()
      lifecycleHooks.registerHooks("test-plugin", { onUnload })
      await lifecycleHooks.dispatchOnUnload("test-plugin")
      expect(onUnload).toHaveBeenCalledTimes(1)
    })

    it("dispatchOnInstall should call the registered onInstall hook", async () => {
      const onInstall = jest.fn()
      lifecycleHooks.registerHooks("test-plugin", { onInstall })
      await lifecycleHooks.dispatchOnInstall("test-plugin")
      expect(onInstall).toHaveBeenCalledTimes(1)
    })

    it("dispatchOnUninstall should call the registered onUninstall hook", async () => {
      const onUninstall = jest.fn()
      lifecycleHooks.registerHooks("test-plugin", { onUninstall })
      await lifecycleHooks.dispatchOnUninstall("test-plugin")
      expect(onUninstall).toHaveBeenCalledTimes(1)
    })

    it("dispatchOnUpdate should call onUpdate with version info", async () => {
      const onUpdate = jest.fn()
      lifecycleHooks.registerHooks("test-plugin", { onUpdate })
      await lifecycleHooks.dispatchOnUpdate("test-plugin", {
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
      })
      expect(onUpdate).toHaveBeenCalledWith({ fromVersion: "1.0.0", toVersion: "1.1.0" })
    })

    it("dispatchOnSuspend should call the registered onSuspend hook", async () => {
      const onSuspend = jest.fn()
      lifecycleHooks.registerHooks("test-plugin", { onSuspend })
      await lifecycleHooks.dispatchOnSuspend("test-plugin")
      expect(onSuspend).toHaveBeenCalledTimes(1)
    })

    it("dispatchOnResume should call the registered onResume hook", async () => {
      const onResume = jest.fn()
      lifecycleHooks.registerHooks("test-plugin", { onResume })
      await lifecycleHooks.dispatchOnResume("test-plugin")
      expect(onResume).toHaveBeenCalledTimes(1)
    })

    it("lifecycle dispatchers no-op when the plugin has no matching hook", async () => {
      lifecycleHooks.registerHooks("test-plugin", {})
      await expect(lifecycleHooks.dispatchOnInstall("test-plugin")).resolves.toBeUndefined()
      await expect(lifecycleHooks.dispatchOnSuspend("test-plugin")).resolves.toBeUndefined()
      await expect(lifecycleHooks.dispatchOnResume("unknown-plugin")).resolves.toBeUndefined()
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

  beforeEach(() => {
    eventHooks = new PluginEventHooks()
    jest.clearAllMocks()
  })

  describe("executeHook timeout", () => {
    it("should not crash when hooks throw errors", () => {
      seedPlugins({
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
      seedPlugins({
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

  describe("Pet dispatchers", () => {
    function withHooks(hooks: Record<string, unknown>) {
      seedPlugins({
        plugins: { "pet-plugin": { status: "enabled", hooks } },
      })
    }

    it("dispatches all five pet hooks with their payloads", async () => {
      const onPetInteract = jest.fn()
      const onPetLevelUp = jest.fn()
      const onPetEvolved = jest.fn()
      const onPetAchievementUnlocked = jest.fn()
      const onPetUnwell = jest.fn()
      withHooks({
        onPetInteract,
        onPetLevelUp,
        onPetEvolved,
        onPetAchievementUnlocked,
        onPetUnwell,
      })

      await eventHooks.dispatchPetInteract({ kind: "fed", source: "user", xp: 3, at: 1 })
      await eventHooks.dispatchPetLevelUp({ level: 5, stage: "juvenile", at: 2 })
      await eventHooks.dispatchPetEvolved({ stage: "juvenile", level: 5, at: 3 })
      await eventHooks.dispatchPetAchievementUnlocked({ achievementId: "well-fed", at: 4 })
      await eventHooks.dispatchPetUnwell({ condition: "unwell", at: 5 })

      expect(onPetInteract).toHaveBeenCalledWith({ kind: "fed", source: "user", xp: 3, at: 1 })
      expect(onPetLevelUp).toHaveBeenCalledWith({ level: 5, stage: "juvenile", at: 2 })
      expect(onPetEvolved).toHaveBeenCalledWith({ stage: "juvenile", level: 5, at: 3 })
      expect(onPetAchievementUnlocked).toHaveBeenCalledWith({ achievementId: "well-fed", at: 4 })
      expect(onPetUnwell).toHaveBeenCalledWith({ condition: "unwell", at: 5 })
    })

    it("isolates a throwing pet hook", async () => {
      withHooks({
        onPetInteract: () => {
          throw new Error("pet hook crash")
        },
      })
      await expect(
        eventHooks.dispatchPetInteract({ kind: "fed", source: "user", xp: 3, at: 1 })
      ).resolves.not.toThrow()
    })
  })

  describe("Code Execution dispatchers", () => {
    it("should dispatch onCodeExecutionStart", () => {
      const handler = jest.fn()
      seedPlugins({
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
      seedPlugins({
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
      seedPlugins({
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
      seedPlugins({
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
      seedPlugins({
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
      seedPlugins({
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
      seedPlugins({
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
      seedPlugins({
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
      seedPlugins({ plugins: {} })
      const out = await eventHooks.dispatchTerminalWillSpawn({ ...baseReq })
      expect(out.decision).toBe("allow")
      expect(out.req).toEqual({ ...baseReq })
    })

    it("returns allow when the only subscriber returns 'allow'", async () => {
      seedPlugins({
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
      seedPlugins({
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
      seedPlugins({
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
      seedPlugins({
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
      seedPlugins({
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
      seedPlugins({
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

  function withHook(hookName: string, fn: jest.Mock) {
    seedPlugins({
      plugins: { "test-plugin": { status: "enabled", hooks: { [hookName]: fn } } },
    })
  }

  afterEach(() => {
    seedPlugins({ plugins: {} })
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

describe("PluginEventHooks - dispatchConnectorDecision (plugin⇄IM)", () => {
  const hooks = getPluginEventHooks()

  afterEach(() => {
    seedPlugins({ plugins: {} })
  })

  const inbound = {
    adapterId: "tg",
    conversationKey: "telegram:tg:1",
    platform: "telegram",
    segments: [{ type: "text", text: "hi" }],
    plainText: "hi",
    messageId: "m1",
  }

  it("returns allow when no plugins are registered", async () => {
    seedPlugins({ plugins: {} })
    const d = await hooks.dispatchConnectorDecision("onConnectorInbound", inbound)
    expect(d).toEqual({ action: "allow" })
  })

  it("returns allow when the plugin returns nothing", async () => {
    seedPlugins({
      plugins: { p: { status: "enabled", hooks: { onConnectorInbound: () => undefined } } },
    })
    const d = await hooks.dispatchConnectorDecision("onConnectorInbound", inbound)
    expect(d).toEqual({ action: "allow" })
  })

  it("first block short-circuits", async () => {
    const later = jest.fn(() => ({ action: "transform", segments: [] }))
    seedPlugins({
      plugins: {
        a: {
          status: "enabled",
          hooks: { onConnectorInbound: () => ({ action: "block", reason: "spam" }) },
        },
        b: { status: "enabled", hooks: { onConnectorInbound: later } },
      },
    })
    const d = await hooks.dispatchConnectorDecision("onConnectorInbound", inbound)
    expect(d).toEqual({ action: "block", reason: "spam" })
  })

  it("transforms chain — last transform wins", async () => {
    seedPlugins({
      plugins: {
        a: {
          status: "enabled",
          hooks: {
            onConnectorInbound: () => ({
              action: "transform",
              segments: [{ type: "text", text: "A" }],
            }),
          },
        },
        b: {
          status: "enabled",
          hooks: {
            onConnectorInbound: () => ({
              action: "transform",
              segments: [{ type: "text", text: "B" }],
            }),
          },
        },
      },
    })
    const d = await hooks.dispatchConnectorDecision("onConnectorInbound", inbound)
    expect(d).toEqual({ action: "transform", segments: [{ type: "text", text: "B" }] })
  })

  it("a throwing plugin is treated as allow (fail-open for plugin errors)", async () => {
    seedPlugins({
      plugins: {
        a: {
          status: "enabled",
          hooks: {
            onConnectorInbound: () => {
              throw new Error("boom")
            },
          },
        },
      },
    })
    const d = await hooks.dispatchConnectorDecision("onConnectorInbound", inbound)
    expect(d).toEqual({ action: "allow" })
  })

  it("dispatches the outbound hook with the outbound payload", async () => {
    const fn = jest.fn(() => ({ action: "allow" }))
    seedPlugins({
      plugins: { p: { status: "enabled", hooks: { onConnectorOutbound: fn } } },
    })
    const outbound = {
      adapterId: "tg",
      conversationKey: "telegram:tg:1",
      platform: "telegram",
      segments: [{ type: "text", text: "out" }],
      source: "ai-run",
      idempotencyKey: "idem-1",
    }
    const d = await hooks.dispatchConnectorDecision("onConnectorOutbound", outbound)
    expect(fn).toHaveBeenCalledWith(outbound)
    expect(d).toEqual({ action: "allow" })
  })
})

// ── W3.7: the executeHook timeout racer must not leak timers ─────────────────
describe("executeHook timer hygiene", () => {
  it("clears the timeout racer once the hook settles", async () => {
    jest.useFakeTimers()
    try {
      seedPlugins({
        plugins: {
          fast: {
            status: "enabled",
            hooks: { onStreamChunk: jest.fn() },
          },
        },
      })
      const eventHooks = getPluginEventHooks()
      // Per-chunk dispatch: each call used to strand one pending timer.
      eventHooks.dispatchStreamChunk("s", "chunk", "full")
      eventHooks.dispatchStreamChunk("s", "chunk2", "fullfull")
      await Promise.resolve()
      await Promise.resolve()
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })
})

describe("PluginLifecycleHooks.dispatchOnCommand", () => {
  let lifecycleHooks: PluginLifecycleHooks

  beforeEach(() => {
    lifecycleHooks = new PluginLifecycleHooks()
    seedPlugins({ plugins: {} })
  })

  it("normalizes the legacy boolean contract to a bare acceptance", async () => {
    // Plugins written against SDK 0.1 return `true`. They must keep working
    // untouched — the host then supplies its own generic response line.
    lifecycleHooks.registerHooks("legacy", { onCommand: () => true })
    await expect(lifecycleHooks.dispatchOnCommand("run", [])).resolves.toEqual({ handled: true })
  })

  it("passes a structured result through untouched", async () => {
    lifecycleHooks.registerHooks("modern", {
      onCommand: () => ({ handled: true, message: "# Report", payload: { citations: 3 } }),
    })
    await expect(lifecycleHooks.dispatchOnCommand("run", [])).resolves.toEqual({
      handled: true,
      message: "# Report",
      payload: { citations: 3 },
    })
  })

  it("hands the command, argv and invoking context to the handler", async () => {
    const onCommand = jest.fn(() => true)
    lifecycleHooks.registerHooks("p", { onCommand })
    await lifecycleHooks.dispatchOnCommand("research", ["a", "b"], {
      sessionId: "s1",
      characterId: "c1",
    })
    expect(onCommand).toHaveBeenCalledWith("research", ["a", "b"], {
      sessionId: "s1",
      characterId: "c1",
    })
  })

  it("returns null when nobody handled it", async () => {
    lifecycleHooks.registerHooks("p", { onCommand: () => false })
    await expect(lifecycleHooks.dispatchOnCommand("run", [])).resolves.toBeNull()
  })

  it("treats `{ handled: false }` as a decline and keeps looking", async () => {
    const declining = jest.fn(() => ({ handled: false as const }))
    lifecycleHooks.registerHooks("first", { onCommand: declining })
    lifecycleHooks.registerHooks("second", {
      onCommand: () => ({ handled: true, message: "mine" }),
    })
    await expect(lifecycleHooks.dispatchOnCommand("run", [])).resolves.toEqual({
      handled: true,
      message: "mine",
    })
    expect(declining).toHaveBeenCalled()
  })

  it("keeps looking past a handler that threw", async () => {
    lifecycleHooks.registerHooks("boom", {
      onCommand: () => {
        throw new Error("nope")
      },
    })
    lifecycleHooks.registerHooks("ok", { onCommand: () => ({ handled: true, message: "mine" }) })
    await expect(lifecycleHooks.dispatchOnCommand("run", [])).resolves.toEqual({
      handled: true,
      message: "mine",
    })
  })
})
