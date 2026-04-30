/**
 * Tests for Promote-to-System utility
 */

// cognia-next uses the global jest setup, so we import nothing from
// `@jest/globals` (Cognia ships that as a dev dep; we don't).
import { promoteToSystemTask } from "./promote-to-system"
import type { ScheduledTask } from "@/types/scheduler"

function createMockTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "test-task-1",
    name: "Test Task",
    type: "script",
    trigger: { type: "cron", cronExpression: "0 9 * * *" },
    config: {
      timeout: 300000,
      maxRetries: 3,
      retryDelay: 5000,
      runMissedOnStartup: false,
      allowConcurrent: false,
    },
    notification: { onStart: false, onComplete: true, onError: true },
    status: "active",
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

describe("promoteToSystemTask", () => {
  describe("promotable tasks", () => {
    it("should promote a script task with cron trigger", () => {
      const task = createMockTask({
        type: "script",
        payload: { language: "python", code: 'print("hello")' },
      })
      const result = promoteToSystemTask(task)

      expect(result.promotable).toBe(true)
      expect(result.input).toBeDefined()
      expect(result.input?.action.type).toBe("execute_script")
      expect(result.input?.trigger.type).toBe("cron")
      expect(result.input?.name).toContain("Cognia:")
      expect(result.input?.tags).toContain("cognia-promoted")
    })

    it("should promote a workflow task", () => {
      const task = createMockTask({
        type: "workflow",
        payload: { workflowId: "wf-123" },
      })
      const result = promoteToSystemTask(task)

      expect(result.promotable).toBe(true)
      expect(result.input?.action.type).toBe("run_command")
      if (result.input?.action.type === "run_command") {
        expect(result.input.action.command).toBe("cognia")
        expect(result.input.action.args).toContain("run-workflow")
      }
    })

    it("should promote a backup task", () => {
      const task = createMockTask({
        type: "backup",
        payload: { backupType: "full", destination: "local" },
      })
      const result = promoteToSystemTask(task)

      expect(result.promotable).toBe(true)
      expect(result.input?.action.type).toBe("run_command")
    })

    it("should promote a sync task", () => {
      const task = createMockTask({
        type: "sync",
        payload: { provider: "webdav" },
      })
      const result = promoteToSystemTask(task)

      expect(result.promotable).toBe(true)
      expect(result.input?.action.type).toBe("run_command")
    })

    it("should map interval trigger correctly", () => {
      const task = createMockTask({
        trigger: { type: "interval", intervalMs: 3600000 },
      })
      const result = promoteToSystemTask(task)

      expect(result.promotable).toBe(true)
      expect(result.input?.trigger.type).toBe("interval")
      if (result.input?.trigger.type === "interval") {
        expect(result.input.trigger.seconds).toBe(3600)
      }
    })

    it("should map once trigger correctly", () => {
      const runAt = new Date("2026-12-31T23:59:59Z")
      const task = createMockTask({
        trigger: { type: "once", runAt },
      })
      const result = promoteToSystemTask(task)

      expect(result.promotable).toBe(true)
      expect(result.input?.trigger.type).toBe("once")
    })
  })

  describe("non-promotable tasks", () => {
    it("should reject agent tasks", () => {
      const task = createMockTask({ type: "agent" })
      const result = promoteToSystemTask(task)

      expect(result.promotable).toBe(false)
      expect(result.reason).toContain("agent")
    })

    it("should reject chat tasks", () => {
      const task = createMockTask({ type: "chat" })
      const result = promoteToSystemTask(task)

      expect(result.promotable).toBe(false)
    })

    it("should reject ai-generation tasks", () => {
      const task = createMockTask({ type: "ai-generation" })
      const result = promoteToSystemTask(task)

      expect(result.promotable).toBe(false)
    })

    it("should reject test tasks", () => {
      const task = createMockTask({ type: "test" })
      const result = promoteToSystemTask(task)

      expect(result.promotable).toBe(false)
    })

    it("should reject custom tasks", () => {
      const task = createMockTask({ type: "custom" })
      const result = promoteToSystemTask(task)

      expect(result.promotable).toBe(false)
    })

    it("should reject plugin tasks", () => {
      const task = createMockTask({ type: "plugin" })
      const result = promoteToSystemTask(task)

      expect(result.promotable).toBe(false)
    })

    it("should reject event trigger type", () => {
      const task = createMockTask({
        type: "script",
        trigger: { type: "event", eventType: "backup:completed" },
      })
      const result = promoteToSystemTask(task)

      expect(result.promotable).toBe(false)
      expect(result.reason).toContain("event")
    })
  })

  describe("edge cases", () => {
    it("should handle missing payload", () => {
      const task = createMockTask({ payload: undefined })
      const result = promoteToSystemTask(task)

      expect(result.promotable).toBe(true)
      expect(result.input?.action.type).toBe("execute_script")
    })

    it("should preserve task tags", () => {
      const task = createMockTask({ tags: ["important", "daily"] })
      const result = promoteToSystemTask(task)

      expect(result.input?.tags).toContain("important")
      expect(result.input?.tags).toContain("daily")
      expect(result.input?.tags).toContain("cognia-promoted")
    })
  })
})
