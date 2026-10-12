/**
 * Driving a `!` job from start to its line in the transcript.
 *
 * One {@link ShellJobRun} per job, held in a module registry rather than in
 * the composer: switching conversation unmounts the composer, and a build the
 * user started must still land its result where they typed it. The run owns
 * three things:
 *
 * - **The live view.** In the foreground it follows the job's merged output
 *   and publishes a snapshot (`subscribeShellJobRun` / `getShellJobRun`) that
 *   the transcript card renders. Nothing is written per chunk: the card reads
 *   the snapshot, the transcript only gets the settled result.
 * - **Move to background.** The card's message is rewritten into a note, the
 *   live view stops, and the run drops to a slow status poll. The job keeps
 *   running in the Job Center; its result is posted as a new message when it
 *   exits.
 * - **The transcript writes.** Every write is an upsert under an id derived
 *   from the job id, so a second client following the same job, or a reload
 *   that re-attaches, rewrites the same rows instead of adding duplicates.
 *
 * Output transport: on the desktop talking to its own supervisor, the run
 * long-polls `background_job_wait`. That command is client-local in the
 * protocol, so a paired client — or a desktop whose execution Host is a
 * remote one — polls `background_job_read`, which every Host serves.
 */

import type { UIMessage } from "ai"

import {
  chatShellJobOwner,
  killBackgroundJob,
  listBackgroundJobs,
  readBackgroundJobOutput,
  readBackgroundJobTail,
  waitBackgroundJobOutput,
  type BackgroundJobOutput,
  type BackgroundJobRecord,
  type BackgroundJobStatus,
} from "@/lib/jobs/background-jobs"
import { DIAGNOSTICS_PART_TYPE, type ShellJobBlock } from "@/lib/slash-commands/system-blocks"
import { isTauri } from "@/lib/tauri"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import { loggers } from "@cognia/logging"
import { MAX_OUTPUT_BYTES } from "./execute"
import {
  appendTail,
  EMPTY_TAIL,
  formatShellJobResult,
  keepTailBytes,
  type OutputTail,
  type ShellJobCopy,
} from "./shell-job"

/** Host-side ceiling on one `background_job_wait` (`crates/cognia-jobs/src/host.rs`). */
export const WAIT_SLICE_MS = 25_000
/** Pause between `background_job_read` polls that found nothing new. */
export const READ_POLL_IDLE_MS = 750
/** Status cadence once the job is in the background. */
export const BACKGROUND_POLL_MS = 2_000
/** Consecutive Host failures tolerated before the run gives up on the job. */
export const MAX_CONSECUTIVE_FAILURES = 5

export type ShellJobPhase =
  /** Streaming into the card. */
  | "running"
  /** Handed to the Job Center; the card is gone. */
  | "background"
  /** Exited and written to the transcript. */
  | "settled"
  /** The Host stopped answering for this job; a note was written. */
  | "lost"
  /** Re-attach found nothing here to follow; nothing was written. */
  | "detached"

export interface ShellJobSnapshot {
  jobId: string
  sessionId: string
  command: string
  cwd: string
  phase: ShellJobPhase
  output: OutputTail
  status: BackgroundJobStatus
  exitCode?: number
  /** A Stop request is in flight. */
  stopping: boolean
}

/** Transcript writes, injected so the run is testable without Dexie. */
export interface ShellJobTranscript {
  /** Insert or replace one message of `sessionId`, in memory and on disk. */
  upsert: (sessionId: string, message: UIMessage) => Promise<void>
}

/** The Host calls a run makes, injected for tests. */
export interface ShellJobHost {
  wait: typeof waitBackgroundJobOutput
  read: typeof readBackgroundJobOutput
  list: typeof listBackgroundJobs
  tail: typeof readBackgroundJobTail
  kill: typeof killBackgroundJob
  /** Whether `background_job_wait` reaches the Host the job runs on. */
  canLongPoll: () => boolean
  sleep: (ms: number) => Promise<void>
}

export interface ShellJobRunDeps {
  transcript: ShellJobTranscript
  copy: ShellJobCopy
  host?: Partial<ShellJobHost>
}

/**
 * Whether `background_job_wait` reaches the Host the job was spawned on. The
 * spawn is an `execution` command, which the desktop's routing transport sends
 * to a selected remote Host; `wait` is `client`, which it always keeps local.
 * Only a desktop with no remote Host selected has both on one supervisor.
 */
export function defaultCanLongPoll(): boolean {
  return isTauri() && !isRemoteHostActive()
}

/** The transcript id of a job's card; it later holds the result or the note. */
export function shellJobCardMessageId(jobId: string): string {
  return `sys-shell-${jobId}`
}

/** The id of the result posted after a job was moved to the background. */
export function shellJobResultMessageId(jobId: string): string {
  return `sys-shell-${jobId}-result`
}

function textMessage(id: string, text: string): UIMessage {
  return { id, role: "system", parts: [{ type: "text", text }] as UIMessage["parts"] }
}

/** The card message the composer posts when a job starts. */
export function buildShellJobCardMessage(block: ShellJobBlock): UIMessage {
  return {
    id: shellJobCardMessageId(block.jobId),
    role: "system",
    parts: [{ type: DIAGNOSTICS_PART_TYPE, data: block }] as UIMessage["parts"],
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type Listener = () => void

export class ShellJobRun {
  private snapshot: ShellJobSnapshot
  private readonly listeners = new Set<Listener>()
  private readonly host: ShellJobHost
  private offset: number
  private failures = 0
  private disposed = false
  /**
   * Cuts short whatever the loop is waiting on — an in-flight long poll when
   * the job moves to the background, a background sleep when Stop is pressed —
   * so the change takes effect now rather than after up to 25 s.
   */
  private wake: (() => void) | null = null

  /** Resolve with `work`, or with `null` as soon as {@link wake} is called. */
  private interruptible<T>(work: Promise<T>): Promise<T | null> {
    return new Promise<T | null>((resolve, reject) => {
      this.wake = () => resolve(null)
      work.then(resolve, reject)
    }).finally(() => {
      this.wake = null
    })
  }

  constructor(
    block: ShellJobBlock,
    private readonly deps: ShellJobRunDeps,
    host: ShellJobHost
  ) {
    this.host = host
    this.offset = 0
    this.snapshot = {
      jobId: block.jobId,
      sessionId: block.sessionId,
      command: block.command,
      cwd: block.cwd,
      phase: "running",
      output: EMPTY_TAIL,
      status: "running",
      stopping: false,
    }
  }

  getSnapshot = (): ShellJobSnapshot => this.snapshot

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Write one transcript row. A failed write is logged, not thrown: the run
   * is a detached promise, and the job's state is already settled in the
   * snapshot either way.
   */
  private async write(message: UIMessage): Promise<void> {
    try {
      await this.deps.transcript.upsert(this.snapshot.sessionId, message)
    } catch (error) {
      loggers.chat.error("writing a shell job's transcript line failed", error, {
        jobId: this.snapshot.jobId,
        messageId: message.id,
      })
    }
  }

  private update(patch: Partial<ShellJobSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  /** Follow the job until it settles. Resolves once its result is written. */
  async run(options: { reattach?: boolean } = {}): Promise<void> {
    try {
      if (options.reattach && !(await this.prime())) return
      while (!this.disposed) {
        if (this.snapshot.phase === "background") {
          if (await this.pollBackground()) return
          continue
        }
        let slice: BackgroundJobOutput | null
        try {
          slice = await this.interruptible(this.nextSlice())
          this.failures = 0
        } catch (error) {
          if (await this.noteFailure(error)) return
          continue
        }
        // Interrupted, or moved to the background while that call was in flight.
        if (!slice || this.snapshot.phase !== "running") continue
        if (slice.data) this.update({ output: appendTail(this.snapshot.output, slice.data) })
        this.offset = slice.nextOffset
        if (slice.status !== "running") {
          if (slice.hasMore) {
            // Behind a chatty command at exit: read only the last 64 KiB
            // instead of draining everything before it.
            await this.settleFromTail(slice.status, slice.exitCode)
          } else {
            await this.settle(slice.status, slice.exitCode, this.snapshot.output)
          }
          return
        }
        if (!slice.data && !this.host.canLongPoll()) await this.host.sleep(READ_POLL_IDLE_MS)
      }
    } finally {
      registry.delete(this.snapshot.jobId)
    }
  }

  /**
   * Re-attach: find the job, and pick it up from its last 64 KiB rather than
   * replaying a long log from byte zero. False when there is nothing to follow.
   *
   * A job this client cannot see — a view on another Host, a supervisor that
   * forgot it — becomes `detached` and writes nothing. It may be running fine
   * on a Host this view is not attached to, and calling it lost here would put
   * a false line in a transcript every client shares.
   */
  private async prime(): Promise<boolean> {
    let job: BackgroundJobRecord | undefined
    try {
      const jobs = await this.host.list(chatShellJobOwner(this.snapshot.sessionId))
      job = jobs.find((candidate) => candidate.id === this.snapshot.jobId)
    } catch {
      job = undefined
    }
    if (!job) {
      this.update({ phase: "detached" })
      return false
    }
    if (job.status !== "running") {
      await this.settleFromTail(job.status, job.exitCode, job)
      return false
    }
    this.offset = Math.max(0, job.totalOutputBytes - MAX_OUTPUT_BYTES)
    if (this.offset > 0) this.update({ output: { text: "", truncated: true } })
    return true
  }

  private nextSlice(): Promise<BackgroundJobOutput> {
    const { jobId } = this.snapshot
    return this.host.canLongPoll()
      ? this.host.wait(jobId, this.offset, { maxBytes: MAX_OUTPUT_BYTES, waitMs: WAIT_SLICE_MS })
      : this.host.read(jobId, this.offset, MAX_OUTPUT_BYTES)
  }

  /** One status check while in the background. True once the run is over. */
  private async pollBackground(): Promise<boolean> {
    let job: BackgroundJobRecord | undefined
    try {
      const jobs = await this.host.list(chatShellJobOwner(this.snapshot.sessionId))
      job = jobs.find((candidate) => candidate.id === this.snapshot.jobId)
      this.failures = 0
    } catch (error) {
      return this.noteFailure(error)
    }
    if (!job) return this.lose("the job is no longer listed by the Host")
    if (job.status !== "running") {
      await this.settleFromTail(job.status, job.exitCode, job)
      return true
    }
    await this.interruptible(this.host.sleep(BACKGROUND_POLL_MS))
    return false
  }

  /** Count a failed Host call; true once there were too many in a row. */
  private async noteFailure(error: unknown): Promise<boolean> {
    this.failures += 1
    if (this.failures >= MAX_CONSECUTIVE_FAILURES) {
      await this.lose(errorText(error))
      return true
    }
    await this.host.sleep(Math.min(READ_POLL_IDLE_MS * 2 ** this.failures, 10_000))
    return false
  }

  private async lose(detail: string): Promise<true> {
    const { jobId, command, phase } = this.snapshot
    const id =
      phase === "background" ? shellJobResultMessageId(jobId) : shellJobCardMessageId(jobId)
    this.update({ phase: "lost" })
    await this.write(textMessage(id, this.deps.copy.lost(command, detail)))
    return true
  }

  private async settleFromTail(
    status: BackgroundJobStatus,
    exitCode: number | undefined,
    known?: BackgroundJobRecord
  ): Promise<void> {
    let output = this.snapshot.output
    try {
      const record =
        known ??
        (await this.host.list(chatShellJobOwner(this.snapshot.sessionId))).find(
          (candidate) => candidate.id === this.snapshot.jobId
        )
      if (record) {
        const tail = await this.host.tail(record, MAX_OUTPUT_BYTES)
        const kept = keepTailBytes(tail.data)
        output = {
          text: kept.text,
          truncated: kept.truncated || record.totalOutputBytes > MAX_OUTPUT_BYTES,
        }
      }
    } catch {
      // The status is already known; settle with whatever was streamed.
    }
    await this.settle(status, exitCode, output)
  }

  private async settle(
    status: BackgroundJobStatus,
    exitCode: number | undefined,
    output: OutputTail
  ): Promise<void> {
    const { jobId, command, phase } = this.snapshot
    const wasBackground = phase === "background"
    this.update({ phase: "settled", status, exitCode, output, stopping: false })
    const text = formatShellJobResult(this.deps.copy, { command, status, exitCode, output })
    const id = wasBackground ? shellJobResultMessageId(jobId) : shellJobCardMessageId(jobId)
    await this.write(textMessage(id, text))
  }

  /**
   * Stop following the job here and let it run on in the Job Center. The card
   * becomes a note; the result arrives as a new message.
   */
  async moveToBackground(): Promise<void> {
    if (this.snapshot.phase !== "running") return
    const { jobId, command } = this.snapshot
    this.update({ phase: "background" })
    this.wake?.()
    await this.write(
      textMessage(shellJobCardMessageId(jobId), this.deps.copy.movedToBackground(command))
    )
  }

  /** Kill the job. The run settles from the `killed` status it reports. */
  async stop(): Promise<void> {
    if (this.snapshot.phase !== "running" && this.snapshot.phase !== "background") return
    this.update({ stopping: true })
    try {
      await this.host.kill(this.snapshot.jobId)
      this.wake?.()
    } catch (error) {
      this.update({ stopping: false })
      throw error
    }
  }

  /** Stop following without writing anything (tests, teardown). */
  dispose(): void {
    this.disposed = true
    this.wake?.()
  }
}

const registry = new Map<string, ShellJobRun>()

function resolveHost(deps: ShellJobRunDeps): ShellJobHost {
  return {
    wait: waitBackgroundJobOutput,
    read: readBackgroundJobOutput,
    list: listBackgroundJobs,
    tail: readBackgroundJobTail,
    kill: killBackgroundJob,
    canLongPoll: defaultCanLongPoll,
    sleep: defaultSleep,
    ...deps.host,
  }
}

/**
 * Begin following a job the composer just started. Returns the existing run
 * when one is already following it.
 */
export function startShellJobRun(block: ShellJobBlock, deps: ShellJobRunDeps): ShellJobRun {
  const existing = registry.get(block.jobId)
  if (existing) return existing
  const run = new ShellJobRun(block, deps, resolveHost(deps))
  registry.set(block.jobId, run)
  void run.run()
  return run
}

/**
 * Pick a card back up after a reload, or on a second client viewing the same
 * conversation. A job this client cannot see becomes `detached` and writes
 * nothing — it may well be running fine on a Host this view is not attached to.
 */
export function reattachShellJobRun(block: ShellJobBlock, deps: ShellJobRunDeps): ShellJobRun {
  const existing = registry.get(block.jobId)
  if (existing) return existing
  const run = new ShellJobRun(block, deps, resolveHost(deps))
  registry.set(block.jobId, run)
  void run.run({ reattach: true })
  return run
}

/** The run following `jobId`, if this client has one. */
export function getShellJobRun(jobId: string): ShellJobRun | undefined {
  return registry.get(jobId)
}

/** Test seam: forget every run. */
export function __resetShellJobRunsForTests(): void {
  for (const run of registry.values()) run.dispose()
  registry.clear()
}
