/**
 * Scheduler timing-driver contracts.
 *
 * The app scheduler (`lib/scheduler/task-scheduler.ts`) keeps all execution,
 * retry, missed-run and dependency logic, but delegates the *timing* of "when
 * does this task become due" to a pluggable driver:
 *
 *   - In the Tauri desktop shell, a Rust in-process alarm daemon owns timing so
 *     tasks fire even when the window is minimized-to-tray (renderer timers are
 *     heavily throttled on hidden webviews). See `lib/scheduler/timing/
 *     rust-daemon-driver.ts` + `src-tauri/src/scheduler/daemon.rs`.
 *   - In the browser / Capacitor shells, timing stays in the renderer via
 *     `setTimeout`/`setInterval` + multi-tab leader election. See
 *     `lib/scheduler/timing/renderer-driver.ts`.
 *
 * The driver is a thin "alarm clock": the scheduler computes the next fire
 * instant (via `cron-parser`) and `arm`s a single absolute timestamp; the
 * driver invokes `onDue` when that instant elapses, and the scheduler executes
 * the task and re-arms the following slot through its existing pipeline.
 */

/** Callback invoked when an armed task's fire instant has elapsed. */
export type TaskDueCallback = (taskId: string, firedAtMs: number) => void

/**
 * Pluggable timing source for the scheduler. Implementations must be safe to
 * `start()`/`stop()` repeatedly and to `arm()` the same task id more than once
 * (latest wins).
 */
export interface SchedulerTimingDriver {
  /**
   * Whether this driver coordinates execution across multiple renderer tabs
   * via leader election. The renderer driver returns `true` (only the leader
   * tab fires); the Rust daemon driver returns `false` (the single native
   * process is the sole authority).
   */
  readonly supportsLeaderElection: boolean

  /**
   * Begin listening for due events / leadership changes. Resolves once the
   * driver is ready to receive `arm` calls. Calling twice is a no-op.
   */
  start(): Promise<void>

  /** Tear down listeners, timers and any leader-election state. */
  stop(): void

  /** Register the callback fired when an armed task becomes due. */
  onDue(cb: TaskDueCallback): void

  /**
   * Arm (or re-arm) a task to fire at the given epoch-ms instant. Re-arming an
   * already-armed task replaces its fire time.
   */
  arm(taskId: string, fireAtMs: number): void | Promise<void>

  /** Cancel a previously-armed task. Safe to call for unknown ids. */
  disarm(taskId: string): void | Promise<void>
}

/**
 * Leader-election aware driver. Only renderer drivers implement this; the
 * scheduler subscribes to drive (re)arm-all / disarm-all on leadership change.
 */
export interface LeaderAwareTimingDriver extends SchedulerTimingDriver {
  readonly supportsLeaderElection: true
  /** Returns whether this tab currently holds leadership. */
  isLeader(): boolean
  /** Subscribe to leadership transitions; returns an unsubscribe fn. */
  onLeaderChange(cb: (isLeader: boolean) => void): () => void
}

/**
 * Payload emitted by the Rust alarm daemon over the `scheduler:task-due`
 * Tauri event. Mirrors `TaskDueEvent` in `src-tauri/src/scheduler/types.rs`
 * (serde camelCase).
 */
export interface DaemonTaskDueEvent {
  taskId: string
  firedAtMs: number
}
