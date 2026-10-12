import type { BackgroundJobOutput, BackgroundJobRecord } from "@/lib/jobs/background-jobs"
import type { ShellJobBlock } from "@/lib/slash-commands/system-blocks"
import { MAX_OUTPUT_BYTES } from "./execute"
import type { ShellJobCopy } from "./shell-job"
import {
  __resetShellJobRunsForTests,
  buildShellJobCardMessage,
  getShellJobRun,
  MAX_CONSECUTIVE_FAILURES,
  reattachShellJobRun,
  shellJobCardMessageId,
  shellJobResultMessageId,
  startShellJobRun,
  type ShellJobHost,
} from "./shell-job-run"

const copy: ShellJobCopy = {
  header: (command, status) => `$ ${command} (${status})`,
  statusExit: (code) => `exit ${code}`,
  statusKilled: "stopped",
  statusInterrupted: "interrupted",
  statusFailed: "failed",
  noOutput: "(no output)",
  truncated: "(last 64 KB)",
  movedToBackground: (command) => `${command} moved to background`,
  lost: (command, error) => `${command} lost: ${error}`,
}

const block: ShellJobBlock = {
  kind: "shell-job",
  jobId: "job-1",
  sessionId: "sess-1",
  command: "pnpm build",
  cwd: "/work",
}

function slice(over: Partial<BackgroundJobOutput> = {}): BackgroundJobOutput {
  return {
    fromOffset: 0,
    nextOffset: 0,
    data: "",
    status: "running",
    hasMore: false,
    ...over,
  }
}

function record(over: Partial<BackgroundJobRecord> = {}): BackgroundJobRecord {
  return {
    id: "job-1",
    command: "pnpm build",
    cwd: "/work",
    owner: { kind: "session", sessionId: "chat-shell:sess-1" },
    status: "running",
    startedAtMs: 0,
    totalOutputBytes: 0,
    droppedOutputBytes: 0,
    ...over,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function setup(host: Partial<ShellJobHost>) {
  const upsert = jest.fn().mockResolvedValue(undefined)
  const fullHost: Partial<ShellJobHost> = {
    canLongPoll: () => true,
    sleep: jest.fn().mockResolvedValue(undefined),
    ...host,
  }
  return { upsert, deps: { transcript: { upsert }, copy, host: fullHost } }
}

/** Resolve once the run following `jobId` has left the registry. */
async function settled(jobId = "job-1") {
  for (let i = 0; i < 50 && getShellJobRun(jobId); i += 1) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

afterEach(() => __resetShellJobRunsForTests())

describe("buildShellJobCardMessage", () => {
  it("carries the block under an id derived from the job", () => {
    const message = buildShellJobCardMessage(block)
    expect(message.id).toBe(shellJobCardMessageId("job-1"))
    expect(message.role).toBe("system")
    expect(message.parts).toEqual([{ type: "data-diagnostics", data: block }])
  })
})

describe("foreground run", () => {
  it("streams output into the snapshot and rewrites the card into the result", async () => {
    const wait = jest
      .fn()
      .mockResolvedValueOnce(slice({ data: "step 1\n", nextOffset: 7 }))
      .mockResolvedValueOnce(
        slice({ data: "done\n", nextOffset: 12, status: "exited", exitCode: 0 })
      )
    const { upsert, deps } = setup({ wait })
    const run = startShellJobRun(block, deps)
    const seen: string[] = []
    run.subscribe(() => seen.push(run.getSnapshot().output.text))
    await settled()

    expect(wait).toHaveBeenNthCalledWith(1, "job-1", 0, expect.objectContaining({ waitMs: 25_000 }))
    expect(wait).toHaveBeenNthCalledWith(2, "job-1", 7, expect.anything())
    expect(seen).toContain("step 1\n")
    expect(run.getSnapshot()).toMatchObject({ phase: "settled", status: "exited", exitCode: 0 })
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(upsert).toHaveBeenCalledWith("sess-1", {
      id: shellJobCardMessageId("job-1"),
      role: "system",
      parts: [{ type: "text", text: "$ pnpm build (exit 0)\n\n```\nstep 1\ndone\n```" }],
    })
  })

  it("polls background_job_read, pausing when idle, where wait cannot reach the Host", async () => {
    const read = jest
      .fn()
      .mockResolvedValueOnce(slice())
      .mockResolvedValueOnce(slice({ data: "ok", nextOffset: 2, status: "exited", exitCode: 0 }))
    const sleep = jest.fn().mockResolvedValue(undefined)
    const wait = jest.fn()
    const { deps } = setup({ read, wait, sleep, canLongPoll: () => false })
    startShellJobRun(block, deps)
    await settled()

    expect(wait).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledWith("job-1", 0, MAX_OUTPUT_BYTES)
    expect(sleep).toHaveBeenCalledWith(750)
  })

  it("reads only the last 64 KiB when the job exits while the view is behind", async () => {
    const wait = jest
      .fn()
      .mockResolvedValue(
        slice({ data: "early", nextOffset: 5, status: "exited", exitCode: 1, hasMore: true })
      )
    const list = jest
      .fn()
      .mockResolvedValue([record({ status: "exited", exitCode: 1, totalOutputBytes: 200_000 })])
    const tail = jest.fn().mockResolvedValue(slice({ data: "the error" }))
    const { upsert, deps } = setup({ wait, list, tail })
    startShellJobRun(block, deps)
    await settled()

    expect(list).toHaveBeenCalledWith({ kind: "session", sessionId: "chat-shell:sess-1" })
    expect(tail).toHaveBeenCalledWith(expect.objectContaining({ id: "job-1" }), MAX_OUTPUT_BYTES)
    expect(upsert.mock.calls[0][1].parts[0].text).toBe(
      "$ pnpm build (exit 1)\n\n(last 64 KB)\n\n```\nthe error\n```"
    )
  })

  it("stops the job and settles from the killed status it reports", async () => {
    const first = deferred<BackgroundJobOutput>()
    const wait = jest
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(slice({ status: "killed" }))
    const kill = jest.fn().mockResolvedValue(record({ status: "killed" }))
    const { upsert, deps } = setup({ wait, kill })
    const run = startShellJobRun(block, deps)

    await run.stop()
    expect(kill).toHaveBeenCalledWith("job-1")
    expect(run.getSnapshot().stopping).toBe(true)
    first.resolve(slice())
    await settled()

    expect(run.getSnapshot()).toMatchObject({ phase: "settled", status: "killed", stopping: false })
    expect(upsert.mock.calls[0][1].parts[0].text).toBe("$ pnpm build (stopped)\n\n(no output)")
  })

  it("clears the stopping flag and rethrows when the kill fails", async () => {
    const wait = jest.fn().mockReturnValue(new Promise(() => {}))
    const { deps } = setup({ wait, kill: jest.fn().mockRejectedValue(new Error("denied")) })
    const run = startShellJobRun(block, deps)
    await expect(run.stop()).rejects.toThrow("denied")
    expect(run.getSnapshot().stopping).toBe(false)
  })

  it("writes a lost note after repeated Host failures", async () => {
    const wait = jest.fn().mockRejectedValue(new Error("host went away"))
    const { upsert, deps } = setup({ wait })
    const run = startShellJobRun(block, deps)
    await settled()

    expect(wait).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES)
    expect(run.getSnapshot().phase).toBe("lost")
    expect(upsert).toHaveBeenCalledWith("sess-1", {
      id: shellJobCardMessageId("job-1"),
      role: "system",
      parts: [{ type: "text", text: "pnpm build lost: host went away" }],
    })
  })

  it("logs a failed transcript write instead of rejecting the detached run", async () => {
    const wait = jest.fn().mockResolvedValue(slice({ status: "exited", exitCode: 0 }))
    const { upsert, deps } = setup({ wait })
    upsert.mockRejectedValue(new Error("disk full"))
    const run = startShellJobRun(block, deps)
    await settled()
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(run.getSnapshot().phase).toBe("settled")
  })

  it("follows each job once", () => {
    const wait = jest.fn().mockReturnValue(new Promise(() => {}))
    const { deps } = setup({ wait })
    const run = startShellJobRun(block, deps)
    expect(startShellJobRun(block, deps)).toBe(run)
    expect(getShellJobRun("job-1")).toBe(run)
    expect(wait).toHaveBeenCalledTimes(1)
  })
})

describe("move to background", () => {
  it("turns the card into a note, polls status, and posts the result as a new message", async () => {
    const first = deferred<BackgroundJobOutput>()
    const wait = jest.fn().mockReturnValueOnce(first.promise)
    const list = jest
      .fn()
      .mockResolvedValueOnce([record()])
      .mockResolvedValueOnce([record({ status: "exited", exitCode: 0, totalOutputBytes: 4 })])
    const tail = jest.fn().mockResolvedValue(slice({ data: "done" }))
    const sleep = jest.fn().mockResolvedValue(undefined)
    const { upsert, deps } = setup({ wait, list, tail, sleep })
    const run = startShellJobRun(block, deps)

    await run.moveToBackground()
    expect(run.getSnapshot().phase).toBe("background")
    expect(upsert).toHaveBeenNthCalledWith(1, "sess-1", {
      id: shellJobCardMessageId("job-1"),
      role: "system",
      parts: [{ type: "text", text: "pnpm build moved to background" }],
    })

    first.resolve(slice({ data: "ignored", nextOffset: 7 }))
    await settled()

    expect(sleep).toHaveBeenCalledWith(2_000)
    expect(wait).toHaveBeenCalledTimes(1)
    expect(upsert).toHaveBeenNthCalledWith(2, "sess-1", {
      id: shellJobResultMessageId("job-1"),
      role: "system",
      parts: [{ type: "text", text: "$ pnpm build (exit 0)\n\n```\ndone\n```" }],
    })
  })

  it("is a no-op once the run is no longer streaming", async () => {
    const wait = jest.fn().mockResolvedValue(slice({ status: "exited", exitCode: 0 }))
    const { upsert, deps } = setup({ wait })
    const run = startShellJobRun(block, deps)
    await settled()
    await run.moveToBackground()
    expect(upsert).toHaveBeenCalledTimes(1)
  })

  it("writes a lost note under the result id when the job vanishes", async () => {
    const wait = jest.fn().mockReturnValue(new Promise(() => {}))
    const list = jest.fn().mockResolvedValue([])
    const { upsert, deps } = setup({ wait, list })
    const run = startShellJobRun(block, deps)
    await run.moveToBackground()
    await settled()
    expect(upsert).toHaveBeenLastCalledWith(
      "sess-1",
      expect.objectContaining({ id: shellJobResultMessageId("job-1") })
    )
    expect(run.getSnapshot().phase).toBe("lost")
  })
})

describe("reattach", () => {
  it("goes detached and writes nothing for a job this client cannot see", async () => {
    const list = jest.fn().mockResolvedValue([])
    const { upsert, deps } = setup({ list })
    const run = reattachShellJobRun(block, deps)
    await settled()
    expect(run.getSnapshot().phase).toBe("detached")
    expect(upsert).not.toHaveBeenCalled()
  })

  it("treats an unreachable Host the same way", async () => {
    const { upsert, deps } = setup({ list: jest.fn().mockRejectedValue(new Error("offline")) })
    const run = reattachShellJobRun(block, deps)
    await settled()
    expect(run.getSnapshot().phase).toBe("detached")
    expect(upsert).not.toHaveBeenCalled()
  })

  it("writes the result of a job that finished while nobody watched", async () => {
    const list = jest
      .fn()
      .mockResolvedValue([record({ status: "interrupted", totalOutputBytes: 3 })])
    const tail = jest.fn().mockResolvedValue(slice({ data: "abc" }))
    const { upsert, deps } = setup({ list, tail })
    reattachShellJobRun(block, deps)
    await settled()
    expect(upsert).toHaveBeenCalledWith("sess-1", {
      id: shellJobCardMessageId("job-1"),
      role: "system",
      parts: [{ type: "text", text: "$ pnpm build (interrupted)\n\n```\nabc\n```" }],
    })
  })

  it("resumes a running job from its last 64 KiB", async () => {
    const list = jest.fn().mockResolvedValue([record({ totalOutputBytes: MAX_OUTPUT_BYTES + 100 })])
    const wait = jest.fn().mockReturnValue(new Promise(() => {}))
    const { deps } = setup({ list, wait })
    const run = reattachShellJobRun(block, deps)
    await new Promise((r) => setTimeout(r, 0))
    expect(wait).toHaveBeenCalledWith("job-1", 100, expect.anything())
    expect(run.getSnapshot().output.truncated).toBe(true)
  })
})
