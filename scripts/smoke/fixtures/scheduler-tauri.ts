/** Real Tauri scheduler integration, isolated from the app account and singleton. */
import { getDb } from "@/lib/db/schema"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { createTaskScheduler, registerTaskExecutor } from "@/lib/scheduler/task-scheduler"
import { RustDaemonTimingDriver } from "@/lib/scheduler/timing/rust-daemon-driver"
import { armTask, disarmTask, listenTaskDue } from "@/lib/scheduler/daemon-bridge"
import { executeTestTask } from "@/lib/scheduler/executors/test-executor"
import type { ScheduledTask, TaskExecutorResult } from "@/types/scheduler"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { invoke } from "@tauri-apps/api/core"
import { registerTaskPrewarmer, unregisterTaskPrewarmer } from "@/lib/scheduler/prewarm"

declare const __SCHEDULER_SMOKE_ID__: string
const prefix = `scheduler-tauri-${__SCHEDULER_SMOKE_ID__}-`
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
async function until<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeout = 15000
): Promise<T> {
  const deadline = Date.now() + timeout
  do {
    const value = await read()
    if (accept(value)) return value
    await delay(30)
  } while (Date.now() < deadline)
  throw new Error("Native scheduler assertion timed out")
}
type Scheduler = ReturnType<typeof createTaskScheduler>
type Runtime = {
  checkMissedTasks(): Promise<void>
  handleTaskDue(id: string, slot: number, version: number): Promise<void>
  executeTask(...args: unknown[]): Promise<unknown>
}
function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
function draft(name: string, config: Partial<ScheduledTask["config"]> = {}): ScheduledTask {
  const now = new Date()
  return {
    id: `${prefix}${name}`,
    name: `Native scheduler smoke ${name}`,
    type: "test",
    status: "active",
    trigger: { type: "interval", intervalMs: 60000 },
    payload: { echo: name },
    config: {
      timeout: 10000,
      maxRetries: 0,
      retryDelay: 1000,
      runMissedOnStartup: true,
      maxMissedRuns: 2,
      allowConcurrent: false,
      ...config,
    },
    notification: {
      onStart: false,
      onComplete: false,
      onError: false,
      onProgress: false,
      channels: ["none"],
    },
    owner: { kind: "this-device", reason: "manual", pinnedAt: Date.now() },
    nextRunAt: new Date(now.getTime() - 5 * 60000),
    createdAt: new Date(now.getTime() - 3600000),
    updatedAt: now,
    runCount: 0,
    successCount: 0,
    failureCount: 0,
  }
}

export async function runSchedulerNativeSmoke(options: { sharedShell?: boolean } = {}) {
  assert(
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
    "A real Tauri webview is required"
  )
  assert(
    getDb().name === `scheduler-native-smoke-${__SCHEDULER_SMOKE_ID__}`,
    "Refusing a non-fixture database"
  )
  const nativeEvents: unknown[] = []
  const stopEvents = await listenTaskDue((event) => {
    if (event.taskId.startsWith(prefix)) nativeEvents.push(event)
  })
  const results: Array<{ name: string; passed: boolean; details?: unknown; error?: string }> = []
  async function run(
    name: string,
    body: (scheduler: Scheduler, driver: RustDaemonTimingDriver) => Promise<unknown>
  ) {
    const driver = new RustDaemonTimingDriver()
    const scheduler = createTaskScheduler(driver)
    try {
      registerTaskExecutor("test", executeTestTask)
      await scheduler.initialize()
      const details = await body(scheduler, driver)
      results.push({ name, passed: true, details })
    } catch (error) {
      results.push({
        name,
        passed: false,
        error: error instanceof Error ? error.stack : String(error),
      })
    } finally {
      scheduler.stop()
      for (const task of await schedulerDb.getAllTasks()) {
        assert(task.id.startsWith(prefix), "Unexpected task in isolated smoke database")
        await scheduler.deleteTask(task.id)
        await disarmTask(task.id)
      }
    }
  }
  try {
    await run("real-native-once", async (scheduler) => {
      const slot = new Date(Date.now() + 1000)
      const task = await scheduler.createTask({
        ...draft("once"),
        trigger: { type: "once", runAt: slot },
      })
      const rows = await until(
        () => schedulerDb.getTaskExecutions(task.id),
        (runs) => runs.some((r) => r.status === "completed")
      )
      assert(
        rows.length === 1 && rows[0].scheduledFor?.getTime() === slot.getTime(),
        "Native slot or execution count differs"
      )
      assert(rows[0].startedAt.getTime() >= slot.getTime(), "Native task ran early")
      assert(
        (rows[0].output as { platform: string }).platform === "tauri",
        "Executor did not run in Tauri"
      )
      assert(
        nativeEvents.some((e) => (e as { taskId: string }).taskId === task.id),
        "Rust due event was not observed"
      )
      return rows[0]
    })
    if (!options.sharedShell)
      await run("native-once-while-window-hidden", async (scheduler) => {
        const nativeWindow = getCurrentWindow()
        const wasVisible = await nativeWindow.isVisible()
        try {
          await nativeWindow.hide()
          assert(!(await nativeWindow.isVisible()), "Native window did not hide")
          const slot = new Date(Date.now() + 1000)
          const task = await scheduler.createTask({
            ...draft("hidden"),
            trigger: { type: "once", runAt: slot },
          })
          const rows = await until(
            () => schedulerDb.getTaskExecutions(task.id),
            (runs) => runs.some((r) => r.status === "completed")
          )
          assert(rows.length === 1, "Hidden native task did not run once")
          assert(!(await nativeWindow.isVisible()), "Window became visible before task completion")
          assert(rows[0].startedAt.getTime() >= slot.getTime(), "Hidden task ran early")
          assert(
            nativeEvents.some((event) => (event as { taskId: string }).taskId === task.id),
            "No native event reached the hidden window"
          )
          return { hidden: true, execution: rows[0] }
        } finally {
          if (wasVisible) await nativeWindow.show()
        }
      })
    await run("promoted-once-canonical-wake", async (scheduler) => {
      const slot = new Date(Date.now() + 1000)
      const task = await scheduler.createTask({
        ...draft("promoted-once"),
        trigger: { type: "once", runAt: slot },
      })
      await scheduler.recordPromotion(task.id, {
        systemTaskId: "fixture-os-once",
        token: "fixture-token",
      })
      const promoted = (await schedulerDb.getTask(task.id))!
      assert(promoted.nextRunAt?.getTime() === slot.getTime(), "Promotion lost canonical slot")
      await schedulerDb.updateTask({ ...promoted, nextRunAt: undefined })
      assert(
        (await scheduler.runPromotedTask(task.id, "fixture-token")) === null,
        "Early legacy wake executed"
      )
      await delay(1200)
      const execution = await scheduler.runPromotedTask(task.id, "fixture-token")
      assert(
        execution?.status === "completed" && execution.scheduledFor?.getTime() === slot.getTime(),
        "Late wake lost trigger identity"
      )
      assert(
        (await scheduler.runPromotedTask(task.id, "fixture-token")) === null,
        "Duplicate wake executed"
      )
      return { earlyRejected: true, duplicateRejected: true, execution }
    })
    for (const action of ["pause", "delete", "stop", "reschedule"] as const) {
      await run(`promoted-read-${action}`, async (scheduler) => {
        const slot = new Date(Date.now() - 60000)
        const task = {
          ...draft(`wake-${action}`),
          trigger: { type: "once" as const, runAt: slot },
          nextRunAt: slot,
          promotion: {
            systemTaskId: "fixture-os-once",
            token: "fixture-token",
            promotedAt: new Date(),
          },
        }
        await schedulerDb.createTask(task)
        scheduler.setSystemSchedulerPort({
          deleteSystemTask: async () => true,
          disableSystemTask: async () => true,
        } as never)
        const read = schedulerDb.getTask.bind(schedulerDb)
        const pending = barrier()
        const entered = barrier()
        let hold = true
        schedulerDb.getTask = async (id) => {
          const row = await read(id)
          if (id === task.id && hold) {
            hold = false
            entered.release()
            await pending.promise
          }
          return row
        }
        const wake = scheduler.runPromotedTask(task.id, "fixture-token")
        try {
          await entered.promise
          if (action === "pause") await scheduler.pauseTask(task.id)
          if (action === "delete") await scheduler.deleteTask(task.id)
          if (action === "stop") scheduler.stop()
          if (action === "reschedule")
            await scheduler.updateTask(task.id, {
              trigger: { type: "once", runAt: new Date(Date.now() + 60000) },
            })
          pending.release()
          assert((await wake) === null, "Stale promoted wake executed")
          assert(
            (await schedulerDb.getTaskExecutions(task.id)).length === 0,
            "Stale wake persisted an execution"
          )
          return { rejected: true }
        } finally {
          pending.release()
          await wake
          schedulerDb.getTask = read
        }
      })
    }
    await run("stale-native-event-after-reschedule", async (scheduler) => {
      const runtime = scheduler as unknown as Runtime
      const original = runtime.handleTaskDue.bind(scheduler)
      let held: [string, number, number] | undefined
      let captured!: () => void
      const delivered = new Promise<void>((resolve) => {
        captured = resolve
      })
      const slot = new Date(Date.now() + 500)
      const id = `${prefix}reschedule`
      runtime.handleTaskDue = async (...args) => {
        if (args[0] === id && args[1] === slot.getTime() && !held) {
          held = args
          captured()
          return
        }
        await original(...args)
      }
      await scheduler.createTask({ ...draft("reschedule"), trigger: { type: "once", runAt: slot } })
      await Promise.race([
        delivered,
        delay(15000).then(() => {
          throw new Error("No old native alarm")
        }),
      ])
      const replacement = new Date(Date.now() + 1000)
      await scheduler.updateTask(id, { trigger: { type: "once", runAt: replacement } })
      assert(held, "Old native alarm was not captured")
      await original(...held)
      assert(
        (await schedulerDb.getTaskExecutions(id)).length === 0,
        "Old event consumed replacement slot"
      )
      const rows = await until(
        () => schedulerDb.getTaskExecutions(id),
        (runs) => runs.some((r) => r.status === "completed")
      )
      assert(
        rows.length === 1 && rows[0].scheduledFor?.getTime() === replacement.getTime(),
        "Replacement did not fire once"
      )
      return { oldSlot: slot, replacement, execution: rows[0] }
    })
    await run("native-pause-and-delete-before-due", async (scheduler) => {
      const slot = new Date(Date.now() + 500)
      const paused = await scheduler.createTask({
        ...draft("paused"),
        trigger: { type: "once", runAt: slot },
      })
      const deleted = await scheduler.createTask({
        ...draft("deleted"),
        trigger: { type: "once", runAt: slot },
      })
      await scheduler.pauseTask(paused.id)
      await scheduler.deleteTask(deleted.id)
      await delay(Math.max(0, slot.getTime() - Date.now()) + 150)
      assert((await schedulerDb.getTaskExecutions(paused.id)).length === 0, "Paused task executed")
      assert((await schedulerDb.getTask(deleted.id)) === null, "Deleted task returned")
      return { paused: (await schedulerDb.getTask(paused.id))?.status, deleted: true }
    })
    for (const action of ["counts", "budget", "auto-pause", "delete", "pause", "stop"] as const) {
      await run(`catchup-${action}`, async (scheduler) => {
        const task = draft(
          action,
          action === "budget"
            ? { maxRuns: 1 }
            : action === "auto-pause"
              ? { pauseAfterConsecutiveFailures: 1 }
              : {}
        )
        let calls = 0
        registerTaskExecutor(
          "test",
          async (current, execution, signal): Promise<TaskExecutorResult> => {
            calls += 1
            if (calls === 1) {
              if (action === "delete") await scheduler.deleteTask(task.id)
              if (action === "pause") await scheduler.pauseTask(task.id)
              if (action === "stop") scheduler.stop()
            }
            if (action === "auto-pause") return { success: false, error: "Expected smoke failure" }
            return executeTestTask(current, execution, signal)
          }
        )
        await schedulerDb.createTask(task)
        await (scheduler as unknown as Runtime).checkMissedTasks()
        const row = await schedulerDb.getTask(task.id)
        if (action === "counts")
          assert(
            calls === 2 && row?.runCount === 2 && row.successCount === 2,
            "Catch-up counters changed"
          )
        else assert(calls === 1, `Catch-up crossed ${action} boundary`)
        if (action === "delete") assert(row === null, "Deleted catch-up task resurrected")
        if (action === "pause" || action === "auto-pause")
          assert(row?.status === "paused", "Catch-up lost pause")
        if (action === "stop")
          assert(!scheduler.getStatus().initialized, "Stopped scheduler restarted")
        return { calls, task: row, status: scheduler.getStatus() }
      })
    }
    await run("fresh-grace-slot-after-long-outage", async (scheduler) => {
      const fresh = new Date()
      fresh.setUTCSeconds(0, 0)
      const task = draft("grace", { maxMissedRuns: 1, catchupWindowMs: 15 * 60000 })
      task.trigger = {
        type: "cron",
        cronExpression: `${fresh.getUTCMinutes()} ${fresh.getUTCHours()} * * *`,
        timezone: "UTC",
      }
      task.nextRunAt = new Date(fresh.getTime() - 2 * 86400000)
      await schedulerDb.createTask(task)
      await (scheduler as unknown as Runtime).checkMissedTasks()
      const row = await schedulerDb.getTask(task.id)
      const runs = await schedulerDb.getTaskExecutions(task.id)
      const completed = runs.filter((r) => r.status === "completed")
      assert(
        completed.length === 1 && completed[0].scheduledFor?.getTime() === fresh.getTime(),
        "Fresh grace slot was lost"
      )
      assert(row?.runCount === 1, "Grace budget changed")
      return { task: row, executions: runs }
    })
    await run("native-ipc-failure-visible-and-unarmed", async (scheduler, driver) => {
      const original = driver.arm.bind(driver)
      let rejected: unknown
      driver.arm = (id) => armTask(id, Number.NaN)
      try {
        await scheduler.createTask({
          ...draft("ipc-error"),
          trigger: { type: "once", runAt: new Date(Date.now() + 3000) },
        })
      } catch (error) {
        rejected = error
      } finally {
        driver.arm = original
      }
      assert(
        (rejected as { code?: string })?.code === "TIMING_DRIVER_FAILED",
        "Native rejection was hidden"
      )
      assert(scheduler.getStatus().scheduledCount === 0, "Failed native arm remained scheduled")
      return {
        code: (rejected as { code: string }).code,
        message: String(rejected),
        status: scheduler.getStatus(),
      }
    })
    await run("native-next-arm-failure-keeps-current-execution", async (scheduler, driver) => {
      const task = await scheduler.createTask({
        ...draft("next-arm-error"),
        trigger: { type: "interval", intervalMs: 1000 },
      })
      const original = driver.arm.bind(driver)
      let rejected = false
      driver.arm = async (id, slot) => {
        if (id === task.id && !rejected) {
          rejected = true
          await armTask(id, Number.NaN)
        } else await original(id, slot)
      }
      try {
        const row = await until(
          () => schedulerDb.getTask(task.id),
          (current) => current?.successCount === 1
        )
        const rows = await schedulerDb.getTaskExecutions(task.id)
        assert(rejected, "Native next-arm rejection was not injected")
        assert(
          rows.length === 1 && rows[0].status === "completed",
          "Claimed current slot was lost or repeated"
        )
        assert(row?.runCount === 1, "Current slot budget changed")
        assert(scheduler.getStatus().scheduledCount === 0, "Rejected future arm remained scheduled")
        return { nativeRejection: rejected, execution: rows[0], task: row }
      } finally {
        driver.arm = original
      }
    })
    await run("native-partial-bootstrap-failure-and-retry", async (scheduler, driver) => {
      scheduler.stop()
      const slot = new Date(Date.now() + 30000)
      const first = draft("bootstrap-a")
      const second = draft("bootstrap-b")
      for (const task of [first, second]) {
        task.trigger = { type: "once", runAt: slot }
        task.nextRunAt = slot
        await schedulerDb.createTask(task)
      }
      const original = driver.arm.bind(driver)
      driver.arm = (id, timestamp) =>
        id === second.id ? armTask(id, Number.NaN) : original(id, timestamp)
      let rejected: unknown
      try {
        await scheduler.initialize()
      } catch (error) {
        rejected = error
      } finally {
        driver.arm = original
      }
      assert(
        (rejected as { code?: string })?.code === "INIT_FAILED",
        "Bootstrap rejection was hidden"
      )
      const failedStatus = scheduler.getStatus()
      assert(
        !failedStatus.initialized && failedStatus.scheduledCount === 0,
        "Partial bootstrap retained phantom alarms"
      )
      await scheduler.initialize()
      assert(
        scheduler.getStatus().initialized && scheduler.getStatus().scheduledCount === 2,
        "Native bootstrap could not retry"
      )
      return { failure: String(rejected), failedStatus, retriedStatus: scheduler.getStatus() }
    })
    for (const action of ["pause", "delete", "reschedule"] as const) {
      await run(`native-${action}-during-rearm`, async (scheduler, driver) => {
        const task = await scheduler.createTask({
          ...draft(`pending-${action}`),
          trigger: { type: "interval", intervalMs: 1000 },
        })
        const runtime = scheduler as unknown as Runtime
        const handle = runtime.handleTaskDue.bind(scheduler)
        const execute = runtime.executeTask.bind(scheduler)
        const executions: Promise<unknown>[] = []
        let delivery: Promise<void> | undefined
        runtime.handleTaskDue = (...args) => {
          const pending = handle(...args)
          if (args[0] === task.id) delivery = pending
          return pending
        }
        runtime.executeTask = (...args) => {
          const pending = execute(...args)
          executions.push(pending)
          return pending
        }
        const original = driver.arm.bind(driver)
        const blocked = barrier()
        let waiting = false
        driver.arm = async (id, slot) => {
          await original(id, slot)
          if (id === task.id && !waiting) {
            waiting = true
            await blocked.promise
          }
        }
        try {
          await until(async () => waiting, Boolean)
          const replacement = new Date(Date.now() + 1000)
          if (action === "pause") await scheduler.pauseTask(task.id)
          if (action === "delete") await scheduler.deleteTask(task.id)
          if (action === "reschedule")
            await scheduler.updateTask(task.id, { trigger: { type: "once", runAt: replacement } })
          blocked.release()
          await delivery
          await Promise.allSettled(executions)
          assert(
            (await schedulerDb.getTaskExecutions(task.id)).length === 0,
            "Invalidated due slot still executed"
          )
          if (action === "reschedule") {
            const rows = await until(
              () => schedulerDb.getTaskExecutions(task.id),
              (runs) => runs.some((r) => r.status === "completed")
            )
            assert(
              rows.length === 1 && rows[0].scheduledFor?.getTime() === replacement.getTime(),
              "Replacement arm was lost or old slot executed"
            )
            return { action, oldSlotCancelled: true, replacementExecution: rows[0] }
          }
          return { action, executions: 0, task: await schedulerDb.getTask(task.id) }
        } finally {
          blocked.release()
          driver.arm = original
        }
      })
    }
    await run("native-once-reschedule-during-expiry", async (scheduler) => {
      const task = draft("once-expiry-race")
      task.trigger = { type: "once", runAt: task.nextRunAt! }
      await schedulerDb.createTask(task)
      const original = schedulerDb.createExecution.bind(schedulerDb)
      const blocked = barrier()
      let waiting = false
      schedulerDb.createExecution = async (execution) => {
        await original(execution)
        if (execution.taskId === task.id && execution.terminalReason === "once-expired") {
          waiting = true
          await blocked.promise
        }
      }
      const reconciliation = (scheduler as unknown as Runtime).checkMissedTasks()
      try {
        await until(async () => waiting, Boolean)
        const replacement = new Date(Date.now() + 1000)
        await scheduler.updateTask(task.id, { trigger: { type: "once", runAt: replacement } })
        blocked.release()
        await reconciliation
        const row = await schedulerDb.getTask(task.id)
        assert(
          row?.status === "active" && row.nextRunAt?.getTime() === replacement.getTime(),
          "Old expiry overwrote replacement"
        )
        const rows = await until(
          () => schedulerDb.getTaskExecutions(task.id),
          (runs) => runs.some((r) => r.status === "completed")
        )
        const completed = rows.filter((r) => r.status === "completed")
        assert(
          completed.length === 1 && completed[0].scheduledFor?.getTime() === replacement.getTime(),
          "Replacement once alarm did not fire exactly once"
        )
        return { replacement, executions: rows }
      } finally {
        blocked.release()
        await reconciliation
        schedulerDb.createExecution = original
      }
    })
    await run("native-stop-during-main-arm-prevents-prewarm", async (scheduler, driver) => {
      registerTaskPrewarmer("test", async () => {})
      const original = driver.arm.bind(driver)
      const blocked = barrier()
      const arms: string[] = []
      driver.arm = async (id, slot) => {
        arms.push(id)
        await original(id, slot)
        await blocked.promise
      }
      const creating = scheduler.createTask({
        ...draft("stop-arm"),
        trigger: { type: "interval", intervalMs: 3600000 },
      })
      try {
        await until(
          async () => arms.length,
          (count) => count > 0
        )
        scheduler.stop()
        blocked.release()
        await creating
        assert(
          arms.length === 1 && !arms.some((id) => id.startsWith("prewarm:")),
          "Stopped scheduler armed a new prewarm"
        )
        return { arms, status: scheduler.getStatus() }
      } finally {
        blocked.release()
        await creating
        driver.arm = original
        unregisterTaskPrewarmer("test")
      }
    })
    return {
      prefix,
      database: getDb().name,
      results,
      nativeEvents,
      passed: results.every((r) => r.passed),
    }
  } finally {
    stopEvents()
    await getDb().delete()
  }
}

/** Real, opt-in provider call. Credentials remain inside the webview. */
export async function runSchedulerProviderSmoke(runtimeConfig?: {
  provider: "openai"
  model: string
  baseURL: string
  apiKey: string
  apiFlavor: "chat"
}) {
  assert(
    !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
    "Real Tauri required"
  )
  assert(getDb().name === `scheduler-native-smoke-${__SCHEDULER_SMOKE_ID__}`, "Private DB required")
  const [{ createLlmClient }, { hasNoLeakingPii }] = await Promise.all([
    import("@/lib/twin/distill/llm"),
    import("@cognia/redact"),
  ])
  const readAccountBinding = () =>
    invoke<{ ownerAccountId?: string; accountGeneration: number }>("gateway_get_status")
  const binding = await readAccountBinding()
  assert(binding.ownerAccountId, "Unlock the intended LocalProfile before provider acceptance")
  let config:
    { apiKey: string; defaultModel: string; baseURL?: string; enabled?: boolean } | undefined
  if (!runtimeConfig) {
    const accountDatabase = `cognia-account-${binding.ownerAccountId}-encrypted-v1`
    const accountMeta = (await indexedDB.databases()).find(
      (entry) => entry.name === accountDatabase
    )
    assert(accountMeta, "The unlocked LocalProfile database is unavailable")
    // Native unlocked-account authority selects the source. No fallback to an
    // inactive profile, and no credential leaves this webview or enters artifacts.
    const account = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(accountDatabase)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      if (account.objectStoreNames.contains("settings")) {
        const stored = await new Promise<
          { providerSettings?: { deepseek?: typeof config } } | undefined
        >((resolve, reject) => {
          const request = account
            .transaction("settings", "readonly")
            .objectStore("settings")
            .get("singleton")
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        config = stored?.providerSettings?.deepseek
      }
    } finally {
      account.close()
    }
    if (!config?.enabled || !config.apiKey || !config.defaultModel) {
      return {
        passed: false,
        blocked: "No enabled DeepSeek credential/model in the unlocked LocalProfile",
        database: getDb().name,
        accountBound: true,
      }
    }
  }
  const model = runtimeConfig?.model ?? config!.defaultModel
  const provider = runtimeConfig ? "aiden-llm-proxy" : "deepseek"
  const client = createLlmClient(
    runtimeConfig ?? {
      provider: "deepseek",
      model,
      apiKey: config!.apiKey,
      baseURL: config!.baseURL,
    }
  )
  config = undefined
  runtimeConfig = undefined
  const sentinel = `SCHEDULER_PROVIDER_${__SCHEDULER_SMOKE_ID__.replaceAll("-", "")}`
  const prompt = `Return exactly this synthetic test marker and nothing else: ${sentinel}`
  assert(hasNoLeakingPii(prompt), "Synthetic probe failed the PII gate")
  const scheduler = createTaskScheduler(new RustDaemonTimingDriver())
  let transport: "complete" | "stream" = "complete"
  try {
    registerTaskExecutor("test", async (_task, _execution, signal) => {
      try {
        const current = await readAccountBinding()
        if (
          current.ownerAccountId !== binding.ownerAccountId ||
          current.accountGeneration !== binding.accountGeneration
        )
          return { success: false, error: "LocalProfile changed before provider send" }
        let text = ""
        let chunks = 0
        const options = { maxTokens: 1024, maxRetries: 0, abortSignal: signal }
        if (transport === "stream") {
          assert(client.stream, "Production client does not support streaming")
          for await (const delta of client.stream(prompt, options)) {
            text += delta
            chunks++
          }
        } else {
          text = await client.complete(prompt, options)
        }
        return {
          success: text.trim() === sentinel,
          output: {
            markerMatched: text.trim() === sentinel,
            provider,
            model,
            transport,
            chunks,
            usage: client.getUsageSnapshot?.(),
          },
        }
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode
        return {
          success: false,
          error: `Provider probe failed${typeof status === "number" ? ` (HTTP ${status})` : ""}`,
        }
      }
    })
    await scheduler.initialize()
    const results = []
    for (const channel of ["complete", "stream"] as const) {
      transport = channel
      const slot = new Date(Date.now() + 500)
      const task = await scheduler.createTask({
        ...draft(`provider-${channel}`),
        config: { ...draft("provider").config, timeout: 45000 },
        trigger: { type: "once", runAt: slot },
      })
      const rows = await until(
        () => schedulerDb.getTaskExecutions(task.id),
        (runs) => runs.some((r) => ["completed", "failed", "cancelled"].includes(r.status)),
        50000
      )
      const execution = rows[0]
      const current = await until(
        () => schedulerDb.getTask(task.id),
        (row) => (row?.successCount ?? 0) + (row?.failureCount ?? 0) >= 1
      )
      const output = execution.output as { markerMatched?: boolean; chunks?: number } | undefined
      const passed =
        rows.length === 1 &&
        execution.status === "completed" &&
        current?.runCount === 1 &&
        current.successCount === 1 &&
        execution.scheduledFor?.getTime() === slot.getTime() &&
        execution.startedAt.getTime() >= slot.getTime() &&
        output?.markerMatched === true &&
        (channel !== "stream" || (output.chunks ?? 0) > 0)
      results.push({
        passed,
        channel,
        task: { id: task.id, runCount: current?.runCount, successCount: current?.successCount },
        execution,
      })
      if (!passed) break
    }
    return {
      passed: results.length === 2 && results.every((result) => result.passed),
      database: getDb().name,
      provider,
      model,
      results,
      scope:
        "Actual scheduler + native timer + production LlmClient + real provider; synthetic diagnostic executor, not built-in chat/plan executor",
    }
  } finally {
    scheduler.stop()
    await schedulerDb.clearAll()
    await getDb().delete()
  }
}

let resumeFixture:
  | { scheduler: Scheduler; id: string; slot: number; events: unknown[]; stopEvents: () => void }
  | undefined
/** Leave an actual native alarm armed while the host physically sleeps. */
export async function armSchedulerResumeSmoke() {
  assert(!resumeFixture, "Resume fixture is already armed")
  assert(getDb().name === `scheduler-native-smoke-${__SCHEDULER_SMOKE_ID__}`, "Private DB required")
  const scheduler = createTaskScheduler(new RustDaemonTimingDriver())
  const events: unknown[] = []
  const stopEvents = await listenTaskDue((event) => {
    if (event.taskId.startsWith(prefix)) events.push(event)
  })
  registerTaskExecutor("test", executeTestTask)
  await scheduler.initialize()
  const slot = Date.now() + 45000
  const task = await scheduler.createTask({
    ...draft("physical-resume"),
    trigger: { type: "once", runAt: new Date(slot) },
  })
  resumeFixture = { scheduler, id: task.id, slot, events, stopEvents }
  return {
    passed: true,
    armed: true,
    taskId: task.id,
    scheduledFor: new Date(slot).toISOString(),
    armedAt: new Date().toISOString(),
    database: getDb().name,
  }
}
export async function readSchedulerResumeSmoke() {
  assert(resumeFixture, "Armed renderer was replaced; do not infer successful resume")
  const { id, slot, events } = resumeFixture
  const executions = await schedulerDb.getTaskExecutions(id)
  return {
    passed:
      executions.length === 1 &&
      executions[0].status === "completed" &&
      executions[0].scheduledFor?.getTime() === slot &&
      events.length === 1,
    executions,
    nativeEvents: events,
    database: getDb().name,
    requiresIndependentSleepWakeLog: true,
  }
}
export async function cleanupSchedulerResumeSmoke() {
  assert(resumeFixture, "No resume fixture in this renderer")
  resumeFixture.scheduler.stop()
  resumeFixture.stopEvents()
  await disarmTask(resumeFixture.id)
  await schedulerDb.clearAll()
  await getDb().delete()
  resumeFixture = undefined
  return { passed: true, database: getDb().name, cleaned: true }
}
