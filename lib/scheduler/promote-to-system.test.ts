/**
 * Tests for Promote-to-System utility
 */

// cognia-next uses the global jest setup, so we import nothing from
// `@jest/globals` (Cognia ships that as a dev dep; we don't).
import {
  buildPromotionWakeUrl,
  generatePromotionToken,
  promoteToSystemTask,
  promotionTokenMatches,
  PROMOTED_TASK_TAG,
} from "./promote-to-system"
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
  describe("promotable tasks (wake + delegate)", () => {
    it("promotes a script task with cron trigger into an open_url wake action", () => {
      const task = createMockTask({
        type: "script",
        payload: { language: "python", code: 'print("hello")' },
      })
      const result = promoteToSystemTask(task, "linux", { token: "tok-1" })

      expect(result.promotable).toBe(true)
      expect(result.token).toBe("tok-1")
      expect(result.input).toBeDefined()
      expect(result.input?.action).toEqual({
        type: "open_url",
        url: "cognia://scheduler/task/test-task-1?run=tok-1",
      })
      expect(result.input?.trigger.type).toBe("cron")
      expect(result.input?.name).toContain("Cognia:")
      expect(result.input?.run_level).toBe("user")
      expect(result.input?.tags).toContain(PROMOTED_TASK_TAG)
      expect(result.input?.tags).toContain("cognia-task:test-task-1")
    })

    it.each([
      "workflow",
      "backup",
      "agent",
      "chat",
      "test",
      "custom",
      "plugin",
      "im-push",
    ] as const)("promotes %s tasks with the same wake action (no per-type CLI mapping)", (type) => {
      const task = createMockTask({
        type,
        trigger: { type: "interval", intervalMs: 3600000 },
        payload: undefined,
      })
      const result = promoteToSystemTask(task, "linux", { token: "t" })
      expect(result.promotable).toBe(true)
      expect(result.input?.action.type).toBe("open_url")
      expect(result.input?.trigger).toEqual({ type: "interval", seconds: 3600 })
    })

    it("mints a fresh token per promotion when none is supplied", () => {
      const a = promoteToSystemTask(createMockTask(), "linux")
      const b = promoteToSystemTask(createMockTask(), "linux")
      expect(a.token).toBeDefined()
      expect(b.token).toBeDefined()
      expect(a.token).not.toBe(b.token)
      expect(a.input?.action.type === "open_url" && a.input.action.url).toBe(
        buildPromotionWakeUrl("test-task-1", a.token!)
      )
    })

    it("should map interval trigger correctly", () => {
      const task = createMockTask({
        trigger: { type: "interval", intervalMs: 3600000 },
      })
      const result = promoteToSystemTask(task, "linux", { token: "t" })

      expect(result.promotable).toBe(true)
      expect(result.input?.trigger.type).toBe("interval")
      if (result.input?.trigger.type === "interval") {
        expect(result.input.trigger.seconds).toBe(3600)
      }
    })

    it("should map once trigger correctly", () => {
      const runAt = new Date("2026-08-17T09:00:00Z")
      const task = createMockTask({ trigger: { type: "once", runAt } })
      const result = promoteToSystemTask(task, "linux", { token: "t" })

      expect(result.promotable).toBe(true)
      expect(result.input?.trigger).toEqual({ type: "once", run_at: runAt.toISOString() })
    })
  })

  describe("wake-up token helpers", () => {
    it("generates a 43-char base64url token from 32 random bytes", () => {
      const token = generatePromotionToken((bytes) => bytes.fill(255))
      // 32 × 0xff → 42 "_" plus a final "8" (last sextet is 111100), no padding.
      expect(token).toBe(`${"_".repeat(42)}8`)
      expect(token).toHaveLength(43)
      expect(token).not.toMatch(/[+/=]/)
      const zero = generatePromotionToken((bytes) => bytes.fill(0))
      expect(zero).toBe("A".repeat(43))
    })

    it("compares tokens strictly", () => {
      expect(promotionTokenMatches("abc", "abc")).toBe(true)
      expect(promotionTokenMatches("abc", "abd")).toBe(false)
      expect(promotionTokenMatches("abc", "ab")).toBe(false)
      expect(promotionTokenMatches(undefined, "abc")).toBe(false)
      expect(promotionTokenMatches("abc", undefined)).toBe(false)
    })

    it("URL-encodes ids and tokens in the wake link", () => {
      expect(buildPromotionWakeUrl("a b", "x/y")).toBe("cognia://scheduler/task/a%20b?run=x%2Fy")
    })
  })

  describe("non-promotable tasks", () => {
    it("rejects deprecated task types", () => {
      for (const type of ["sync", "ai-generation"] as const) {
        const result = promoteToSystemTask(createMockTask({ type }), "linux")
        expect(result.promotable).toBe(false)
        expect(result.reason).toContain("deprecated")
      }
    })

    it("should reject event trigger type", () => {
      const task = createMockTask({
        type: "script",
        trigger: { type: "event", eventType: "backup:completed" },
      })
      const result = promoteToSystemTask(task, "linux")

      expect(result.promotable).toBe(false)
      expect(result.reason).toContain("event")
    })
  })

  describe("cron grammar guard", () => {
    it("promotes a fixed-value 5-field cron", () => {
      const task = createMockTask({
        trigger: { type: "cron", cronExpression: "0 9 * * 1" },
        payload: { language: "bash", code: "echo hi" },
      })
      expect(promoteToSystemTask(task).promotable).toBe(true)
    })

    it.each([
      ["*/15 * * * *", /step|\/15/i],
      ["0 9 * * 1-5", /range|1-5/i],
      ["0 9 * * 1,3,5", /list|1,3,5/i],
    ])("rejects cron syntax launchd cannot represent: %s", (cronExpression, reason) => {
      const task = createMockTask({ trigger: { type: "cron", cronExpression } })
      const result = promoteToSystemTask(task, "macos")

      expect(result.promotable).toBe(false)
      expect(result.reason).toMatch(reason)
    })

    it("keeps step, range, and list cron available to non-launchd backends", () => {
      for (const cronExpression of ["*/15 * * * *", "0 9 * * 1-5", "0 9 * * 1,3,5"]) {
        const task = createMockTask({ trigger: { type: "cron", cronExpression } })
        expect(promoteToSystemTask(task, "windows").promotable).toBe(true)
        expect(promoteToSystemTask(task, "linux").promotable).toBe(true)
      }
    })

    it("rejects seconds-level (6-field) cron", () => {
      const task = createMockTask({
        trigger: { type: "cron", cronExpression: "*/30 0 9 * * *" },
      })
      const result = promoteToSystemTask(task)
      expect(result.promotable).toBe(false)
      expect(result.reason).toMatch(/6-field|seconds/i)
    })

    it("rejects the last-day (L) modifier", () => {
      const task = createMockTask({
        trigger: { type: "cron", cronExpression: "0 0 L * *" },
      })
      const result = promoteToSystemTask(task)
      expect(result.promotable).toBe(false)
      expect(result.reason).toMatch(/L |modifier/i)
    })

    it("rejects the nth-weekday (#) modifier", () => {
      const task = createMockTask({
        trigger: { type: "cron", cronExpression: "0 0 * * 5#2" },
      })
      const result = promoteToSystemTask(task)
      expect(result.promotable).toBe(false)
      expect(result.reason).toMatch(/#|modifier/i)
    })

    it("rejects predefined macros", () => {
      const task = createMockTask({
        trigger: { type: "cron", cronExpression: "@daily" },
      })
      const result = promoteToSystemTask(task)
      expect(result.promotable).toBe(false)
      expect(result.reason).toMatch(/macro/i)
    })

    it("rejects an invalid cron expression", () => {
      const task = createMockTask({
        trigger: { type: "cron", cronExpression: "99 99 * * *" },
      })
      const result = promoteToSystemTask(task)
      expect(result.promotable).toBe(false)
      expect(result.reason).toMatch(/invalid/i)
    })
  })

  describe("edge cases", () => {
    it("should handle missing payload", () => {
      const task = createMockTask({ payload: undefined })
      const result = promoteToSystemTask(task, "linux")

      expect(result.promotable).toBe(true)
      expect(result.input?.action.type).toBe("open_url")
    })

    it("should preserve task tags", () => {
      const task = createMockTask({ tags: ["important", "daily"] })
      const result = promoteToSystemTask(task, "linux")

      expect(result.input?.tags).toContain("important")
      expect(result.input?.tags).toContain("daily")
      expect(result.input?.tags).toContain("cognia-promoted")
    })
  })
})
