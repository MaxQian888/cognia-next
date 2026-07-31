/**
 * @jest-environment jsdom
 */

import {
  __setSchedulerNotificationSettingsForTesting,
  notifyTaskEvent,
  testNotificationChannel,
} from "./notification-integration"
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

// Desktop + toast now funnel through the Notification Center core (ADR-0042).
jest.mock("@/lib/notifications/runtime", () => ({
  notify: jest.fn().mockResolvedValue("center-id"),
}))

// The `im` channel test pushes through the conversation notifier (which owns the
// DND / opt-in / PII gating downstream); stub it so the assertion is about what
// the scheduler asked for, not about delivery.
jest.mock("@/lib/notifications/conversation-notify", () => ({
  notifyConversationOverIM: jest.fn().mockResolvedValue("center-id"),
}))

// Lazily imported by the IM fallback resolution when no test reader is injected.
jest.mock("@/lib/db/settings", () => ({
  getSettings: jest.fn().mockResolvedValue({}),
}))

jest.mock("@cognia/logging", () => ({
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
import { notify as centerNotify } from "@/lib/notifications/runtime"
import { notifyConversationOverIM } from "@/lib/notifications/conversation-notify"
import { getSettings } from "@/lib/db/settings"
import { toast } from "sonner"

const mockSendNotification = notify as jest.MockedFunction<typeof notify>
const mockCenterNotify = centerNotify as jest.MockedFunction<typeof centerNotify>
const mockNotifyConversationOverIM = notifyConversationOverIM as jest.MockedFunction<
  typeof notifyConversationOverIM
>
const mockGetSettings = getSettings as unknown as jest.Mock

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

      expect(mockCenterNotify).not.toHaveBeenCalled()
    })

    it("should skip notification if channels is empty", async () => {
      const taskWithEmptyChannels = {
        ...mockTask,
        notification: { ...mockTask.notification, channels: [] },
      } as unknown as ScheduledTask

      await notifyTaskEvent(taskWithEmptyChannels, mockExecution, "start")

      expect(mockCenterNotify).not.toHaveBeenCalled()
    })

    it("routes a desktop start event to the center as an os channel", async () => {
      const desktopOnlyTask = {
        ...mockTask,
        notification: { ...mockTask.notification, channels: ["desktop"] as const },
      } as unknown as ScheduledTask

      await notifyTaskEvent(desktopOnlyTask, mockExecution, "start")

      expect(mockCenterNotify).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "scheduler",
          level: "info",
          title: "Task Started: Test Task",
          channels: ["center", "os"],
          dedupeKey: "task:task-1:start",
          groupKey: "task:task-1",
        })
      )
    })

    it("routes a toast complete event to the center with success level", async () => {
      const toastOnlyTask = {
        ...mockTask,
        notification: { ...mockTask.notification, channels: ["toast"] as const },
      } as unknown as ScheduledTask

      await notifyTaskEvent(toastOnlyTask, mockExecution, "complete")

      expect(mockCenterNotify).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "success",
          channels: ["center", "toast"],
          title: "Task Completed: Test Task",
        })
      )
    })

    it("routes an error event with error level + message body", async () => {
      const toastOnlyTask = {
        ...mockTask,
        notification: { ...mockTask.notification, channels: ["toast"] as const },
      } as unknown as ScheduledTask

      const errorExecution = { ...mockExecution, status: "failed" as const, error: "Test error" }

      await notifyTaskEvent(toastOnlyTask, errorExecution, "error")

      expect(mockCenterNotify).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "error",
          body: expect.stringContaining("Test error"),
        })
      )
    })

    it("routes desktop + toast as a single emit with both channels", async () => {
      await notifyTaskEvent(mockTask, mockExecution, "complete")

      expect(mockCenterNotify).toHaveBeenCalledTimes(1)
      expect(mockCenterNotify).toHaveBeenCalledWith(
        expect.objectContaining({ channels: ["center", "toast", "os"] })
      )
    })

    it("describes a progress event", async () => {
      await notifyTaskEvent(mockTask, mockExecution, "progress")

      expect(mockCenterNotify).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "info",
          title: "Task Progress: Test Task",
        })
      )
    })

    // Auto-pause is the one event whose body has to tell the operator what to do
    // next, so its wording is pinned rather than left to drift.
    it("warns on auto-pause and names the failure threshold", async () => {
      const pausedTask = {
        ...mockTask,
        config: { pauseAfterConsecutiveFailures: 3 },
      } as unknown as ScheduledTask

      await notifyTaskEvent(pausedTask, mockExecution, "auto-paused")

      expect(mockCenterNotify).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "warning",
          title: "Task Auto-Paused: Test Task",
          body: expect.stringContaining("3 consecutive failures"),
        })
      )
    })

    it("falls back to a generic body when the threshold is unset", async () => {
      const pausedTask = { ...mockTask, config: {} } as unknown as ScheduledTask

      await notifyTaskEvent(pausedTask, mockExecution, "auto-paused")

      expect(mockCenterNotify).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.stringContaining("several consecutive failures") })
      )
    })

    it("reports a completion without a measured duration", async () => {
      const noDuration = { ...mockExecution, duration: undefined }

      await notifyTaskEvent(mockTask, noDuration, "complete")

      expect(mockCenterNotify).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.stringContaining("Completed successfully") })
      )
    })

    // The `im` channel: the center, the delivery implementation and the
    // per-conversation opt-in all existed already — the scheduler's narrower
    // channel union was the only thing blocking a task result from reaching a
    // chat window.
    describe("im channel", () => {
      afterEach(() => __setSchedulerNotificationSettingsForTesting(null))

      function imTask(
        imTarget: { conversationKey: string } | undefined,
        channels: readonly string[] = ["im"]
      ): ScheduledTask {
        return {
          ...mockTask,
          notification: { ...mockTask.notification, channels, imTarget },
        } as unknown as ScheduledTask
      }

      it("delivers to the task's own target and carries the conversation sourceRef", async () => {
        __setSchedulerNotificationSettingsForTesting(async () => ({}))

        await notifyTaskEvent(
          imTask({ conversationKey: "discord:a1:ch_ops" }),
          mockExecution,
          "error"
        )

        expect(mockCenterNotify).toHaveBeenCalledTimes(1)
        expect(mockCenterNotify).toHaveBeenCalledWith(
          expect.objectContaining({
            channels: ["center", "im"],
            // im-deliver resolves its destination from this and nothing else.
            sourceRef: { kind: "conversation", id: "discord:a1:ch_ops" },
            // Task grouping survives even though the ref had to change.
            groupKey: "task:task-1",
          })
        )
      })

      it("falls back to the global ops channel when the task names no target", async () => {
        __setSchedulerNotificationSettingsForTesting(async () => ({
          fallbackConversationKey: "slack:ops:C123",
        }))

        await notifyTaskEvent(imTask(undefined), mockExecution, "error")

        expect(mockCenterNotify).toHaveBeenCalledWith(
          expect.objectContaining({
            channels: ["center", "im"],
            sourceRef: { kind: "conversation", id: "slack:ops:C123" },
          })
        )
      })

      it("prefers the task target over the global fallback", async () => {
        __setSchedulerNotificationSettingsForTesting(async () => ({
          fallbackConversationKey: "slack:ops:C123",
        }))

        await notifyTaskEvent(
          imTask({ conversationKey: "discord:a1:ch_own" }),
          mockExecution,
          "error"
        )

        expect(mockCenterNotify).toHaveBeenCalledWith(
          expect.objectContaining({
            sourceRef: { kind: "conversation", id: "discord:a1:ch_own" },
          })
        )
      })

      // No target anywhere → drop only the IM channel. The durable center record
      // still has to be written, or asking for IM delivery would LOSE the event.
      it("keeps the center record and the task sourceRef when no target resolves", async () => {
        __setSchedulerNotificationSettingsForTesting(async () => ({}))

        await notifyTaskEvent(imTask(undefined, ["im", "toast"]), mockExecution, "error")

        expect(mockCenterNotify).toHaveBeenCalledWith(
          expect.objectContaining({
            channels: ["center", "toast"],
            sourceRef: { kind: "task", id: "task-1" },
          })
        )
      })

      it("emits one record for im + toast + desktop together", async () => {
        __setSchedulerNotificationSettingsForTesting(async () => ({}))

        await notifyTaskEvent(
          imTask({ conversationKey: "discord:a1:ch_ops" }, ["im", "toast", "desktop"]),
          mockExecution,
          "complete"
        )

        expect(mockCenterNotify).toHaveBeenCalledTimes(1)
        expect(mockCenterNotify).toHaveBeenCalledWith(
          expect.objectContaining({ channels: ["center", "toast", "os", "im"] })
        )
      })

      it("treats a whitespace-only target as absent", async () => {
        __setSchedulerNotificationSettingsForTesting(async () => ({
          fallbackConversationKey: "   ",
        }))

        await notifyTaskEvent(
          imTask({ conversationKey: "  " }, ["im", "toast"]),
          mockExecution,
          "error"
        )

        expect(mockCenterNotify).toHaveBeenCalledWith(
          expect.objectContaining({ channels: ["center", "toast"] })
        )
      })

      // A settings read failure must cost only the IM channel, never the others.
      it("degrades to the remaining channels when the settings read throws", async () => {
        __setSchedulerNotificationSettingsForTesting(async () => {
          throw new Error("db closed")
        })

        await notifyTaskEvent(imTask(undefined, ["im", "toast"]), mockExecution, "error")

        expect(mockCenterNotify).toHaveBeenCalledWith(
          expect.objectContaining({ channels: ["center", "toast"] })
        )
      })

      // `testNotificationChannel` switches on the channel; a missing `im` case
      // would fall straight through to `{ success: true }` and claim the test
      // passed without sending anything.
      describe('testNotificationChannel("im")', () => {
        it("fails with a readable reason when no conversation resolves", async () => {
          __setSchedulerNotificationSettingsForTesting(async () => ({}))

          const result = await testNotificationChannel("im")

          expect(result.success).toBe(false)
          expect(result.error).toContain("No IM conversation is configured")
        })

        it("pushes through the conversation notifier using the passed key", async () => {
          __setSchedulerNotificationSettingsForTesting(async () => ({}))

          const result = await testNotificationChannel("im", undefined, "discord:a1:ch_typed")

          expect(result.success).toBe(true)
          expect(mockNotifyConversationOverIM).toHaveBeenCalledWith(
            expect.objectContaining({
              conversationKey: "discord:a1:ch_typed",
              source: "scheduler",
            })
          )
        })

        it("falls back to the global ops channel when no key is passed", async () => {
          __setSchedulerNotificationSettingsForTesting(async () => ({
            fallbackConversationKey: "slack:ops:C123",
          }))

          const result = await testNotificationChannel("im")

          expect(result.success).toBe(true)
          expect(mockNotifyConversationOverIM).toHaveBeenCalledWith(
            expect.objectContaining({ conversationKey: "slack:ops:C123" })
          )
        })
      })

      // Production path: no injected reader, so the lazy `getSettings` import
      // runs. Without this the real fallback lookup would be untested.
      it("reads the fallback from real settings when nothing is injected", async () => {
        __setSchedulerNotificationSettingsForTesting(null)
        mockGetSettings.mockResolvedValueOnce({
          schedulerNotifications: { fallbackConversationKey: "lark:ops:oc_1" },
        })

        await notifyTaskEvent(imTask(undefined), mockExecution, "error")

        expect(mockGetSettings).toHaveBeenCalled()
        expect(mockCenterNotify).toHaveBeenCalledWith(
          expect.objectContaining({
            channels: ["center", "im"],
            sourceRef: { kind: "conversation", id: "lark:ops:oc_1" },
          })
        )
      })

      it("drops only the IM channel when real settings have no fallback", async () => {
        __setSchedulerNotificationSettingsForTesting(null)
        mockGetSettings.mockResolvedValueOnce({})

        await notifyTaskEvent(imTask(undefined, ["im", "toast"]), mockExecution, "error")

        expect(mockCenterNotify).toHaveBeenCalledWith(
          expect.objectContaining({ channels: ["center", "toast"] })
        )
      })

      it("does not read settings at all when im is not requested", async () => {
        const read = jest.fn(async () => ({ fallbackConversationKey: "slack:ops:C123" }))
        __setSchedulerNotificationSettingsForTesting(read)

        await notifyTaskEvent(imTask(undefined, ["toast"]), mockExecution, "complete")

        expect(read).not.toHaveBeenCalled()
        expect(mockCenterNotify).toHaveBeenCalledWith(
          expect.objectContaining({ channels: ["center", "toast"] })
        )
      })
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
        expect.objectContaining({ method: "POST" })
      )
      // The delivery now carries a Standard-Webhooks-shaped body.
      const [, init] = (fetch as jest.Mock).mock.calls[0]
      const body = JSON.parse(init.body as string)
      expect(body).toMatchObject({ source: "scheduler", eventType: "complete" })
    })

    it("should handle notification errors gracefully", async () => {
      mockCenterNotify.mockRejectedValueOnce(new Error("Notification failed"))

      await expect(notifyTaskEvent(mockTask, mockExecution, "start")).resolves.toBeUndefined()
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
