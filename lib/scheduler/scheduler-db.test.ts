/** @jest-environment jsdom */
/**
 * Scheduler Database Tests
 */

// Mock IndexedDB for tests
import "fake-indexeddb/auto"
import { schedulerDb, SCHEDULER_DB_NAME, SCHEDULER_SNAPSHOT_EXCLUDED_TABLES } from "./scheduler-db"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"

describe("SchedulerDatabase", () => {
  beforeEach(async () => {
    await schedulerDb.clearAll()
  })

  const createMockTask = (overrides: Partial<ScheduledTask> = {}): ScheduledTask => ({
    id: `task-${Date.now()}`,
    name: "Test Task",
    description: "A test task",
    type: "workflow",
    trigger: {
      type: "cron",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
    },
    payload: { workflowId: "test-workflow" },
    config: {
      timeout: 300000,
      maxRetries: 3,
      retryDelay: 5000,
      runMissedOnStartup: false,
      maxMissedRuns: 1,
      allowConcurrent: false,
    },
    notification: {
      onStart: false,
      onComplete: true,
      onError: true,
      onProgress: false,
      channels: ["toast"],
    },
    status: "active",
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  })

  const createMockExecution = (
    taskId: string,
    overrides: Partial<TaskExecution> = {}
  ): TaskExecution => ({
    id: `exec-${Date.now()}`,
    taskId,
    taskName: "Test Task",
    taskType: "workflow",
    status: "completed",
    retryAttempt: 0,
    duration: 1000,
    startedAt: new Date(),
    completedAt: new Date(),
    logs: [],
    ...overrides,
  })

  describe("Task Operations", () => {
    it("should create and retrieve a task", async () => {
      const task = createMockTask({ id: "test-task-1" })
      await schedulerDb.createTask(task)

      const retrieved = await schedulerDb.getTask("test-task-1")
      expect(retrieved).not.toBeNull()
      expect(retrieved!.name).toBe("Test Task")
      expect(retrieved!.type).toBe("workflow")
    })

    it("should update a task", async () => {
      const task = createMockTask({ id: "test-task-2" })
      await schedulerDb.createTask(task)

      const updated = { ...task, name: "Updated Task", updatedAt: new Date() }
      await schedulerDb.updateTask(updated)

      const retrieved = await schedulerDb.getTask("test-task-2")
      expect(retrieved!.name).toBe("Updated Task")
    })

    it("atomically claims a schedule slot only once, reserves runCount, and advances nextRunAt", async () => {
      const expectedRunAt = new Date("2026-07-25T09:00:00.000Z")
      const nextRunAt = new Date("2026-07-25T10:00:00.000Z")
      const task = createMockTask({
        id: "claim-once",
        nextRunAt: expectedRunAt,
      })
      await schedulerDb.createTask(task)

      const [first, second] = await Promise.all([
        schedulerDb.claimTaskSlot(task.id, expectedRunAt, nextRunAt),
        schedulerDb.claimTaskSlot(task.id, expectedRunAt, nextRunAt),
      ])

      expect([first, second].filter(Boolean)).toHaveLength(1)
      expect(await schedulerDb.getTask(task.id)).toEqual(
        expect.objectContaining({ nextRunAt, runCount: 1 })
      )
    })

    it("does not expose another slot after atomically reserving the final maxRuns budget", async () => {
      const expectedRunAt = new Date("2026-07-25T09:00:00.000Z")
      const nextRunAt = new Date("2026-07-25T09:00:00.100Z")
      const task = createMockTask({
        id: "claim-final-budget",
        nextRunAt: expectedRunAt,
        config: { ...createMockTask().config, maxRuns: 1, overlapPolicy: "allow" },
      })
      await schedulerDb.createTask(task)

      const claimed = await schedulerDb.claimTaskSlot(task.id, expectedRunAt, nextRunAt)

      expect(claimed).toEqual(expect.objectContaining({ runCount: 1, nextRunAt: undefined }))
      expect(await schedulerDb.getTask(task.id)).toEqual(
        expect.objectContaining({ runCount: 1, nextRunAt: undefined })
      )
    })

    it("does not claim a stale or paused schedule slot", async () => {
      const expectedRunAt = new Date("2026-07-25T09:00:00.000Z")
      await schedulerDb.createTask(
        createMockTask({
          id: "paused-claim",
          status: "paused",
          nextRunAt: expectedRunAt,
        })
      )

      await expect(schedulerDb.claimTaskSlot("paused-claim", expectedRunAt)).resolves.toBeNull()
      await expect(
        schedulerDb.claimTaskSlot("paused-claim", new Date("2026-07-25T08:00:00.000Z"))
      ).resolves.toBeNull()
    })

    it("should delete a task and its executions", async () => {
      const task = createMockTask({ id: "test-task-3" })
      await schedulerDb.createTask(task)

      const execution = createMockExecution("test-task-3")
      await schedulerDb.createExecution(execution)

      const deleted = await schedulerDb.deleteTask("test-task-3")
      expect(deleted).toBe(true)

      const retrieved = await schedulerDb.getTask("test-task-3")
      expect(retrieved).toBeNull()

      const executions = await schedulerDb.getTaskExecutions("test-task-3")
      expect(executions.length).toBe(0)
    })

    it("should get all tasks", async () => {
      await schedulerDb.createTask(createMockTask({ id: "task-a" }))
      await schedulerDb.createTask(createMockTask({ id: "task-b" }))
      await schedulerDb.createTask(createMockTask({ id: "task-c" }))

      const tasks = await schedulerDb.getAllTasks()
      expect(tasks.length).toBe(3)
    })

    it("should get tasks by status", async () => {
      await schedulerDb.createTask(createMockTask({ id: "task-active", status: "active" }))
      await schedulerDb.createTask(createMockTask({ id: "task-paused", status: "paused" }))
      await schedulerDb.createTask(createMockTask({ id: "task-active-2", status: "active" }))

      const activeTasks = await schedulerDb.getTasksByStatus("active")
      expect(activeTasks.length).toBe(2)

      const pausedTasks = await schedulerDb.getTasksByStatus("paused")
      expect(pausedTasks.length).toBe(1)
    })

    it("should get overdue active tasks via the [status+nextRunAt] index", async () => {
      const now = new Date()
      await schedulerDb.createTask(
        createMockTask({
          id: "task-overdue",
          status: "active",
          nextRunAt: new Date(now.getTime() - 60_000),
        })
      )
      await schedulerDb.createTask(
        createMockTask({
          id: "task-future",
          status: "active",
          nextRunAt: new Date(now.getTime() + 60_000),
        })
      )
      await schedulerDb.createTask(
        createMockTask({
          id: "task-no-next-run",
          status: "active",
          nextRunAt: undefined,
        })
      )
      await schedulerDb.createTask(
        createMockTask({
          id: "task-paused-overdue",
          status: "paused",
          nextRunAt: new Date(now.getTime() - 60_000),
        })
      )

      const overdue = await schedulerDb.getOverdueActiveTasks(now)
      expect(overdue.map((t) => t.id)).toEqual(["task-overdue"])
    })

    it("should filter tasks by multiple criteria", async () => {
      await schedulerDb.createTask(
        createMockTask({
          id: "task-1",
          type: "workflow",
          status: "active",
          tags: ["important", "daily"],
        })
      )
      await schedulerDb.createTask(
        createMockTask({
          id: "task-2",
          type: "agent",
          status: "active",
          tags: ["weekly"],
        })
      )
      await schedulerDb.createTask(
        createMockTask({
          id: "task-3",
          type: "workflow",
          status: "paused",
          tags: ["important"],
        })
      )

      // Filter by type
      const workflowTasks = await schedulerDb.getFilteredTasks({ types: ["workflow"] })
      expect(workflowTasks.length).toBe(2)

      // Filter by status
      const activeTasks = await schedulerDb.getFilteredTasks({ statuses: ["active"] })
      expect(activeTasks.length).toBe(2)

      // Filter by tags
      const importantTasks = await schedulerDb.getFilteredTasks({ tags: ["important"] })
      expect(importantTasks.length).toBe(2)
    })
  })

  describe("Execution Operations", () => {
    it("should create and retrieve executions", async () => {
      const task = createMockTask({ id: "task-exec-test" })
      await schedulerDb.createTask(task)

      const execution = createMockExecution("task-exec-test", { id: "exec-1" })
      await schedulerDb.createExecution(execution)

      const executions = await schedulerDb.getTaskExecutions("task-exec-test")
      expect(executions.length).toBe(1)
      expect(executions[0].status).toBe("completed")
    })

    it("should update execution status", async () => {
      const task = createMockTask({ id: "task-exec-update" })
      await schedulerDb.createTask(task)

      const execution = createMockExecution("task-exec-update", {
        id: "exec-update",
        status: "running",
      })
      await schedulerDb.createExecution(execution)

      const updated = { ...execution, status: "completed" as const, completedAt: new Date() }
      await schedulerDb.updateExecution(updated)

      const retrieved = await schedulerDb.getExecution("exec-update")
      expect(retrieved!.status).toBe("completed")
    })

    it("should get recent executions", async () => {
      const task = createMockTask({ id: "task-recent" })
      await schedulerDb.createTask(task)

      for (let i = 0; i < 5; i++) {
        await schedulerDb.createExecution(
          createMockExecution("task-recent", {
            id: `exec-${i}`,
            startedAt: new Date(Date.now() - i * 1000),
          })
        )
      }

      const recent = await schedulerDb.getRecentExecutions(3)
      expect(recent.length).toBe(3)
    })

    it("filters before limiting recent executions for a scheduler source", async () => {
      for (let i = 0; i < 3; i++) {
        await schedulerDb.createExecution(
          createMockExecution("app-task", {
            id: `app-exec-${i}`,
            taskType: "chat",
            startedAt: new Date(2_000 + i),
          })
        )
      }
      await schedulerDb.createExecution(
        createMockExecution("plugin-task", {
          id: "plugin-exec",
          taskType: "plugin",
          startedAt: new Date(1_000),
        })
      )

      const recent = await schedulerDb.getRecentExecutionsMatching(
        (taskType) => taskType === "plugin",
        1
      )
      expect(recent.map((execution) => execution.id)).toEqual(["plugin-exec"])
    })

    it("should cleanup old executions", async () => {
      const task = createMockTask({ id: "task-cleanup" })
      await schedulerDb.createTask(task)

      // Create old execution
      const oldDate = new Date()
      oldDate.setDate(oldDate.getDate() - 10)
      await schedulerDb.createExecution(
        createMockExecution("task-cleanup", {
          id: "old-exec",
          startedAt: oldDate,
        })
      )

      // Create recent execution
      await schedulerDb.createExecution(
        createMockExecution("task-cleanup", {
          id: "recent-exec",
          startedAt: new Date(),
        })
      )

      const deleted = await schedulerDb.cleanupOldExecutions(5)
      expect(deleted).toBe(1)

      const remaining = await schedulerDb.getTaskExecutions("task-cleanup")
      expect(remaining.length).toBe(1)
      expect(remaining[0].id).toBe("recent-exec")
    })

    it("interruptStaleExecutions cancels orphaned running/pending rows and leaves terminal ones", async () => {
      await schedulerDb.createExecution(
        createMockExecution("task-boot", { id: "run-1", status: "running", completedAt: undefined })
      )
      await schedulerDb.createExecution(
        createMockExecution("task-boot", {
          id: "pend-1",
          status: "pending",
          completedAt: undefined,
        })
      )
      await schedulerDb.createExecution(
        createMockExecution("task-boot", { id: "done-1", status: "completed" })
      )

      const reconciled = await schedulerDb.interruptStaleExecutions()
      expect(reconciled).toBe(2)

      const run = await schedulerDb.getExecution("run-1")
      const pend = await schedulerDb.getExecution("pend-1")
      const done = await schedulerDb.getExecution("done-1")
      expect(run!.status).toBe("cancelled")
      expect(run!.terminalReason).toBe("interrupted-on-restart")
      expect(run!.completedAt).toBeInstanceOf(Date)
      expect(pend!.status).toBe("cancelled")
      // A terminal row is never touched.
      expect(done!.status).toBe("completed")
    })

    it("interruptStaleExecutions is a no-op when nothing is running", async () => {
      await schedulerDb.createExecution(
        createMockExecution("task-boot", { id: "done-2", status: "completed" })
      )
      expect(await schedulerDb.interruptStaleExecutions()).toBe(0)
    })
  })

  describe("Statistics", () => {
    it("should calculate task statistics", async () => {
      await schedulerDb.createTask(
        createMockTask({
          id: "stat-task-1",
          status: "active",
          successCount: 10,
          failureCount: 2,
        })
      )
      await schedulerDb.createTask(
        createMockTask({
          id: "stat-task-2",
          status: "paused",
          successCount: 5,
          failureCount: 1,
        })
      )

      await schedulerDb.createExecution(
        createMockExecution("stat-task-1", {
          id: "stat-exec-1",
          status: "completed",
          duration: 1000,
        })
      )
      await schedulerDb.createExecution(
        createMockExecution("stat-task-1", {
          id: "stat-exec-2",
          status: "failed",
          duration: 500,
        })
      )

      const stats = await schedulerDb.getStatistics()
      expect(stats.totalTasks).toBe(2)
      expect(stats.activeTasks).toBe(1)
      expect(stats.pausedTasks).toBe(1)
      expect(stats.totalExecutions).toBe(2)
      expect(stats.successfulExecutions).toBe(1)
      expect(stats.failedExecutions).toBe(1)
    })
  })

  describe("Serialization", () => {
    it("should correctly serialize and deserialize dates", async () => {
      const now = new Date()
      const task = createMockTask({
        id: "date-test",
        lastRunAt: now,
        nextRunAt: new Date(now.getTime() + 3600000),
        trigger: {
          type: "once",
          runAt: new Date(now.getTime() + 7200000),
        },
      })

      await schedulerDb.createTask(task)
      const retrieved = await schedulerDb.getTask("date-test")

      expect(retrieved!.lastRunAt instanceof Date).toBe(true)
      expect(retrieved!.nextRunAt instanceof Date).toBe(true)
      expect(retrieved!.trigger.runAt instanceof Date).toBe(true)
    })

    it("should correctly serialize and deserialize execution logs", async () => {
      const task = createMockTask({ id: "log-test" })
      await schedulerDb.createTask(task)

      const execution = createMockExecution("log-test", {
        id: "log-exec",
        logs: [
          { id: "log-1", timestamp: new Date(), level: "info", message: "Started" },
          {
            id: "log-2",
            timestamp: new Date(),
            level: "error",
            message: "Failed",
            data: { code: 500 },
          },
        ],
      })

      await schedulerDb.createExecution(execution)
      const retrieved = await schedulerDb.getExecution("log-exec")

      expect(retrieved!.logs.length).toBe(2)
      expect(retrieved!.logs[0].timestamp instanceof Date).toBe(true)
      expect(retrieved!.logs[1].data).toEqual({ code: 500 })
    })

    it("round-trips tasks without payload and keeps them queryable", async () => {
      const nextRunAt = new Date(Date.now() + 60_000)
      const task = createMockTask({
        id: "optional-payload-task",
        payload: undefined,
        nextRunAt,
        trigger: { type: "interval", intervalMs: 60_000 },
      })
      await schedulerDb.createTask(task)

      const retrieved = await schedulerDb.getTask("optional-payload-task")
      expect(retrieved).toEqual(
        expect.objectContaining({
          id: "optional-payload-task",
          payload: undefined,
        })
      )

      const upcoming = await schedulerDb.getUpcomingTasks(10)
      expect(upcoming.map((item) => item.id)).toContain("optional-payload-task")
    })

    it("should persist structured terminal metadata for tasks and executions", async () => {
      const task = createMockTask({
        id: "terminal-meta-task",
        lastTerminalReason: "missed-run-skipped",
        lastTerminalAt: new Date(),
      })
      await schedulerDb.createTask(task)

      const execution = createMockExecution("terminal-meta-task", {
        id: "terminal-meta-exec",
        triggerSource: "catch-up",
        scheduledFor: new Date(Date.now() - 60000),
        terminalReason: "missed-run-skipped",
        retryScheduledAt: new Date(),
      })
      await schedulerDb.createExecution(execution)

      const retrievedTask = await schedulerDb.getTask("terminal-meta-task")
      const retrievedExecution = await schedulerDb.getExecution("terminal-meta-exec")

      expect(retrievedTask?.lastTerminalReason).toBe("missed-run-skipped")
      expect(retrievedTask?.lastTerminalAt instanceof Date).toBe(true)
      expect(retrievedExecution?.triggerSource).toBe("catch-up")
      expect(retrievedExecution?.terminalReason).toBe("missed-run-skipped")
      expect(retrievedExecution?.scheduledFor instanceof Date).toBe(true)
      expect(retrievedExecution?.retryScheduledAt instanceof Date).toBe(true)
    })

    it("round-trips lifecycle, chain, and policy fields", async () => {
      const endAt = new Date(Date.now() + 86_400_000)
      const task = createMockTask({
        id: "policy-roundtrip",
        endAt,
        onSuccessTaskIds: ["next-1", "next-2"],
        onFailureTaskIds: ["cleanup-1"],
        consecutiveFailures: 2,
        config: {
          timeout: 1000,
          maxRetries: 0,
          retryDelay: 100,
          runMissedOnStartup: false,
          overlapPolicy: "queue-all",
          maxQueueSize: 5,
          maxRuns: 20,
          pauseAfterConsecutiveFailures: 3,
          catchupWindowMs: 3_600_000,
        },
        trigger: { type: "interval", intervalMs: 60_000, jitterMs: 2_000 },
      })

      await schedulerDb.createTask(task)
      const retrieved = await schedulerDb.getTask("policy-roundtrip")

      expect(retrieved?.endAt?.toISOString()).toBe(endAt.toISOString())
      expect(retrieved?.onSuccessTaskIds).toEqual(["next-1", "next-2"])
      expect(retrieved?.onFailureTaskIds).toEqual(["cleanup-1"])
      expect(retrieved?.consecutiveFailures).toBe(2)
      expect(retrieved?.config.overlapPolicy).toBe("queue-all")
      expect(retrieved?.config.maxQueueSize).toBe(5)
      expect(retrieved?.config.maxRuns).toBe(20)
      expect(retrieved?.config.pauseAfterConsecutiveFailures).toBe(3)
      expect(retrieved?.config.catchupWindowMs).toBe(3_600_000)
      expect(retrieved?.trigger.jitterMs).toBe(2_000)
    })

    it("leaves optional new fields undefined when unset", async () => {
      await schedulerDb.createTask(createMockTask({ id: "no-new-fields" }))
      const retrieved = await schedulerDb.getTask("no-new-fields")

      expect(retrieved?.endAt).toBeUndefined()
      expect(retrieved?.onSuccessTaskIds).toBeUndefined()
      expect(retrieved?.onFailureTaskIds).toBeUndefined()
      expect(retrieved?.consecutiveFailures).toBeUndefined()
    })
  })

  describe("overlapPolicy load-time migration", () => {
    it("derives 'allow' from legacy allowConcurrent: true", async () => {
      const task = createMockTask({ id: "legacy-allow" })
      task.config.allowConcurrent = true
      delete task.config.overlapPolicy
      await schedulerDb.createTask(task)

      const retrieved = await schedulerDb.getTask("legacy-allow")
      expect(retrieved?.config.overlapPolicy).toBe("allow")
    })

    it("derives 'skip' from legacy allowConcurrent: false", async () => {
      const task = createMockTask({ id: "legacy-skip" })
      task.config.allowConcurrent = false
      delete task.config.overlapPolicy
      await schedulerDb.createTask(task)

      const retrieved = await schedulerDb.getTask("legacy-skip")
      expect(retrieved?.config.overlapPolicy).toBe("skip")
    })

    it("never clobbers an explicit overlapPolicy (idempotent)", async () => {
      const task = createMockTask({ id: "explicit-policy" })
      task.config.allowConcurrent = true
      task.config.overlapPolicy = "cancel-previous"
      await schedulerDb.createTask(task)

      const retrieved = await schedulerDb.getTask("explicit-policy")
      expect(retrieved?.config.overlapPolicy).toBe("cancel-previous")

      // Re-persist and re-read: still untouched.
      await schedulerDb.updateTask(retrieved!)
      const again = await schedulerDb.getTask("explicit-policy")
      expect(again?.config.overlapPolicy).toBe("cancel-previous")
    })
  })

  // Third axis of the intentional-dormancy label (Working Rule 7): the type
  // documents the exemption, the headless snapshot source consumes it, and this
  // pins it. `tasks` MUST stay persistable — dropping it is what made a
  // restarted `cognia serve` brain reboot with an empty schedule.
  describe("headless snapshot exclusions", () => {
    it("excludes only executions, never tasks", () => {
      expect(SCHEDULER_SNAPSHOT_EXCLUDED_TABLES).toEqual(["executions"])
      expect(SCHEDULER_SNAPSHOT_EXCLUDED_TABLES).not.toContain("tasks")
    })

    it("names every excluded table as a real table on this database", () => {
      const declared = schedulerDb.tables.map((table) => table.name)
      for (const excluded of SCHEDULER_SNAPSHOT_EXCLUDED_TABLES) {
        expect(declared).toContain(excluded)
      }
    })

    it("pins the database name the snapshot files it under", () => {
      expect(SCHEDULER_DB_NAME).toBe("CogniaSchedulerDB")
      expect(schedulerDb.name).toBe(SCHEDULER_DB_NAME)
    })
  })
})
