/**
 * Event Integration Tests
 */

import {
  emitSchedulerEvent,
  createEventData,
  isValidEventType,
  type SchedulerEventType,
} from "./event-integration"

// Mock the task scheduler
const mockTriggerEventTask = jest.fn().mockResolvedValue(undefined)
jest.mock("./task-scheduler", () => ({
  getTaskScheduler: jest.fn(() => ({
    triggerEventTask: mockTriggerEventTask,
  })),
}))

// Mock logger — supply every namespace the scheduler module touches.
jest.mock("@/lib/logging", () => {
  const stub = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  return {
    loggers: { app: stub, scheduler: stub, store: stub, plugin: stub },
    createLogger: () => stub,
  }
})

describe("event-integration", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("emitSchedulerEvent", () => {
    it("should emit event with correct parameters", async () => {
      const eventType: SchedulerEventType = "session:completed"
      const data = { sessionId: "test-123" }

      await emitSchedulerEvent(eventType, data)

      expect(mockTriggerEventTask).toHaveBeenCalledWith(eventType, undefined, data)
    })

    it("should emit event with event source", async () => {
      const eventType: SchedulerEventType = "sync:completed"
      const data = { syncId: "sync-456" }
      const eventSource = "manual"

      await emitSchedulerEvent(eventType, data, eventSource)

      expect(mockTriggerEventTask).toHaveBeenCalledWith(eventType, eventSource, data)
    })

    it("should emit event without data", async () => {
      const eventType: SchedulerEventType = "backup:needed"

      await emitSchedulerEvent(eventType)

      expect(mockTriggerEventTask).toHaveBeenCalledWith(eventType, undefined, undefined)
    })

    it("should throw error when scheduler fails", async () => {
      mockTriggerEventTask.mockRejectedValueOnce(new Error("Trigger failed"))

      await expect(emitSchedulerEvent("session:completed", { id: "123" })).rejects.toThrow(
        "Trigger failed"
      )
    })
  })

  describe("createEventData", () => {
    it("should create event data with timestamp", () => {
      const eventType: SchedulerEventType = "session:created"
      const data = { sessionId: "test-789" }

      const result = createEventData(eventType, data)

      expect(result.eventType).toBe(eventType)
      expect(result.data).toEqual(data)
      expect(result.timestamp).toBeInstanceOf(Date)
    })

    it("should create event data without additional data", () => {
      const eventType: SchedulerEventType = "backup:completed"

      const result = createEventData(eventType)

      expect(result.eventType).toBe(eventType)
      expect(result.data).toBeUndefined()
      expect(result.timestamp).toBeInstanceOf(Date)
    })
  })

  describe("isValidEventType", () => {
    it("should return true for valid event types", () => {
      const validTypes: SchedulerEventType[] = [
        "session:created",
        "session:completed",
        "session:deleted",
        "sync:started",
        "sync:completed",
        "sync:failed",
        "backup:needed",
        "backup:completed",
        "workflow:completed",
        "agent:completed",
        "custom",
      ]

      for (const eventType of validTypes) {
        expect(isValidEventType(eventType)).toBe(true)
      }
    })

    it("should return false for invalid event types", () => {
      expect(isValidEventType("invalid:event")).toBe(false)
      expect(isValidEventType("")).toBe(false)
      expect(isValidEventType("random")).toBe(false)
    })
  })
})
