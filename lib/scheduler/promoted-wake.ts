/**
 * OS-promoted task wake-up (ADR-0128 §5, "wake-and-delegate").
 *
 * The native scheduler entry opens `cognia://scheduler/task/<id>?run=<token>`.
 * That URL reaches the renderer through two doors:
 *
 *   - `deep-link://received` while the app is already running
 *     (`hooks/system/use-tauri-events.ts`), and
 *   - the launch URL when the OS timer had to start the app
 *     (`components/providers/tauri-provider.tsx` → `getLaunchDeepLink`).
 *
 * Both call {@link handlePromotedTaskWake}: select the task, navigate to the
 * scheduler, and — only when the link carries the task's own promotion token —
 * run it through the ordinary in-app executor. A bare link just navigates.
 * Token verification happens in `TaskScheduler.runPromotedTask`.
 */

export interface PromotedTaskWakeInput {
  taskId: string
  runToken?: string
}

export interface PromotedTaskWakeDeps {
  /** Route the UI to the scheduler page (router.push / window.location). */
  navigate: (path: string) => void
  /** Injectable for tests; defaults to the real store + scheduler modules. */
  loadStore?: () => Promise<{
    selectTask: (taskId: string | null) => void
    initialize: () => Promise<void>
  }>
  loadRunner?: () => Promise<(taskId: string, runToken: string) => Promise<unknown>>
  warn?: (message: string, data: Record<string, unknown>) => void
}

async function defaultLoadStore() {
  const { useSchedulerStore } = await import("@/stores/scheduler/scheduler-store")
  return {
    selectTask: (taskId: string | null) => useSchedulerStore.getState().selectTask(taskId),
    initialize: () => useSchedulerStore.getState().initialize(),
  }
}

async function defaultLoadRunner() {
  const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
  return (taskId: string, runToken: string) => getTaskScheduler().runPromotedTask(taskId, runToken)
}

/**
 * Handle a `cognia://scheduler/task/<id>[?run=<token>]` link. Resolves once
 * navigation happened and (when a token is present) the promoted run was
 * attempted; never throws — wake-up failures are logged, not fatal.
 */
export async function handlePromotedTaskWake(
  input: PromotedTaskWakeInput,
  deps: PromotedTaskWakeDeps
): Promise<{ ran: boolean }> {
  const { taskId, runToken } = input
  const store = await (deps.loadStore ?? defaultLoadStore)()
  store.selectTask(taskId)
  deps.navigate("/scheduler")
  if (!runToken) return { ran: false }
  try {
    await store.initialize()
    const run = await (deps.loadRunner ?? defaultLoadRunner)()
    await run(taskId, runToken)
    return { ran: true }
  } catch (err) {
    ;(deps.warn ?? ((message, data) => console.warn(message, data)))(
      "promoted task wake-up failed",
      { taskId, err }
    )
    return { ran: false }
  }
}
