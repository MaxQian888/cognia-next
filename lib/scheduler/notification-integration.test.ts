/**
 * @jest-environment jsdom
 */

import { notifyTaskEvent, testNotificationChannel } from "./notification-integration"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"

// Mock dependencies
jest.mock("@/lib/tauri/notification", () => ({
  notify: jest.fn().mockResolvedValue(undefined),
  ensureNotificationPermission: jest.fn().mockResolvedValue("granted"),
}))

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}))

jest.mock("@/lib/logging", () => ({
  loggers: {
    app: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    },
    scheduler: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    },
  },
}))

import { notify } from "@/lib/tauri/notification"
import { toast } from "sonner"

const mockSendNotification = notify as jest.MockedFunction<typeof notify>

describe("notification-integration", () => {
  const mockTask = {
    id: "task-1",
    name: "Test Task",
    type: "ai-generation",
    trigger: { type: "interval", intervalMs: 60000 },
    notification: {
      onStart: true,
      onComplete: true,
      onError: true,
      onProgress: false,
      channels: ["desktop", "toast"] as const,
      webhookUrl: undefined,
    },
  } as unknown as ScheduledTask

  const mockExecution: TaskExecution = {
    id: "exec-1",
    taskId: "task-1",
    taskName: "Test Task",
    taskType: "ai-generation",
    status: "completed",
    retryAttempt: 0,
    startedAt: new Date(),
    completedAt: new Date(),
    duration: 1500,
    logs: [],
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("notifyTaskEvent", () => {
    it("should skip notification if channels contains none", async () => {
      const taskWithNone = {
        ...mockTask,
        notification: { ...mockTask.notification, channels: ["none"] as const },
      } as unknown as ScheduledTask

      await notifyTaskEvent(taskWithNone, mockExecution, "start")

      expect(mockSendNotification).not.toHaveBeenCalled()
      expect(toast.info).not.toHaveBeenCalled()
    })

    it("should skip notification if channels is empty", async () => {
      const taskWithEmptyChannels = {
        ...mockTask,
        notification: { ...mockTask.notification, channels: [] },
      } as unknown as ScheduledTask

      await notifyTaskEvent(taskWithEmptyChannels, mockExecution, "start")

      expect(mockSendNotification).not.toHaveBeenCalled()
    })

    it("should send desktop notification for start event", async () => {
      const desktopOnlyTask = {
        ...mockTask,
        notification: { ...mockTask.notification, channels: ["desktop"] as const },
      } as unknown as ScheduledTask

      await notifyTaskEvent(desktopOnlyTask, mockExecution, "start")

      expect(mockSendNotification).toHaveBeenCalledWith({
        title: "Task Started: Test Task",
        body: expect.stringContaining("has started execution"),
      })
    })

    it("should send toast notification for complete event", async () => {
      const toastOnlyTask = {
        ...mockTask,
        notification: { ...mockTask.notification, channels: ["toast"] as const },
      } as unknown as ScheduledTask

      await notifyTaskEvent(toastOnlyTask, mockExecution, "complete")

      expect(toast.success).toHaveBeenCalledWith(
        "Task Completed: Test Task",
        expect.objectContaining({ description: expect.stringContaining("has completed") })
      )
    })

    it("should send error toast for error event", async () => {
      const toastOnlyTask = {
        ...mockTask,
        notification: { ...mockTask.notification, channels: ["toast"] as const },
      } as unknown as ScheduledTask

      const errorExecution = { ...mockExecution, status: "failed" as const, error: "Test error" }

      await notifyTaskEvent(toastOnlyTask, errorExecution, "error")

      expect(toast.error).toHaveBeenCalledWith(
        "Task Failed: Test Task",
        expect.objectContaining({ description: expect.stringContaining("Test error") })
      )
    })

    it("should send to multiple channels", async () => {
      await notifyTaskEvent(mockTask, mockExecution, "complete")

      expect(mockSendNotification).toHaveBeenCalled()
      expect(toast.success).toHaveBeenCalled()
    })

    it("should send webhook notification", async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true })

      const webhookTask = {
        ...mockTask,
        notification: {
          ...mockTask.notification,
          channels: ["webhook"] as const,
          webhookUrl: "https://example.com/webhook",
        },
      } as unknown as ScheduledTask

      await notifyTaskEvent(webhookTask, mockExecution, "complete")

      expect(fetch).toHaveBeenCalledWith(
        "https://example.com/webhook",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        })
      )
    })

    it("should handle notification errors gracefully", async () => {
      mockSendNotification.mockRejectedValueOnce(new Error("Notification failed"))

      await notifyTaskEvent(mockTask, mockExecution, "start")

      // Should not throw, just log error
    })
  })

  describe("testNotificationChannel", () => {
    it("should test desktop notification", async () => {
      const result = await testNotificationChannel("desktop")

      expect(result.success).toBe(true)
      expect(mockSendNotification).toHaveBeenCalledWith({
        title: "Notification Test",
        body: "This is a test notification from the scheduler.",
      })
    })

    it("should test toast notification", async () => {
      const result = await testNotificationChannel("toast")

      expect(result.success).toBe(true)
      expect(toast.info).toHaveBeenCalledWith(
        "Notification Test",
        expect.objectContaining({ description: "This is a test notification from the scheduler." })
      )
    })

    it("should return error when webhook URL is missing", async () => {
      const result = await testNotificationChannel("webhook")

      expect(result.success).toBe(false)
      expect(result.error).toBe("Webhook URL is required")
    })

    it("should test webhook notification with URL", async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true })

      const result = await testNotificationChannel("webhook", "https://example.com/webhook")

      expect(result.success).toBe(true)
      expect(fetch).toHaveBeenCalled()
    })

    it("should return success for none channel", async () => {
      const result = await testNotificationChannel("none")

      expect(result.success).toBe(true)
    })

    it("should tolerate desktop notification errors", async () => {
      mockSendNotification.mockRejectedValueOnce(new Error("Test failed"))

      const result = await testNotificationChannel("desktop")

      expect(result.success).toBe(true)
      expect(mockSendNotification).toHaveBeenCalledWith({
        title: "Notification Test",
        body: "This is a test notification from the scheduler.",
      })
    })
  })
})
