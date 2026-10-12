/**
 * @jest-environment jsdom
 */
import React from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { ShellJobBlock } from "@/lib/slash-commands/system-blocks"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))

// The re-attach path resolves its Host calls from this module; the other tests
// inject theirs. A Host that cannot list the job is the one under test.
jest.mock("@/lib/jobs/background-jobs", () => ({
  chatShellJobOwner: (sessionId: string) => ({
    kind: "session",
    sessionId: `chat-shell:${sessionId}`,
  }),
  listBackgroundJobs: jest.fn(async () => {
    throw new Error("no host")
  }),
  killBackgroundJob: jest.fn(),
  readBackgroundJobOutput: jest.fn(),
  readBackgroundJobTail: jest.fn(),
  waitBackgroundJobOutput: jest.fn(),
}))

jest.mock("@/lib/chat/shell-job-transcript", () => ({
  shellJobTranscript: { upsert: jest.fn(async () => undefined) },
}))

import {
  __resetShellJobRunsForTests,
  getShellJobRun,
  startShellJobRun,
  type ShellJobHost,
} from "@/lib/shell-intelligence/shell-job-run"
import type { ShellJobCopy } from "@/lib/shell-intelligence/shell-job"
import { ShellJobCard, ShellJobView } from "./shell-job-view"

const block: ShellJobBlock = {
  kind: "shell-job",
  jobId: "job-1",
  sessionId: "sess-1",
  command: "pnpm build",
  cwd: "/work",
}

const copy: ShellJobCopy = {
  header: (command, status) => `${command} ${status}`,
  statusExit: (code) => `exit ${code}`,
  statusKilled: "stopped",
  statusInterrupted: "interrupted",
  statusFailed: "failed",
  noOutput: "none",
  truncated: "clipped",
  movedToBackground: (command) => `${command} moved`,
  lost: (command) => `${command} lost`,
}

function startRun(host: Partial<ShellJobHost>) {
  const upsert = jest.fn(async () => undefined)
  const run = startShellJobRun(block, {
    transcript: { upsert },
    copy,
    host: { canLongPoll: () => true, sleep: async () => undefined, ...host },
  })
  return { run, upsert }
}

afterEach(() => {
  __resetShellJobRunsForTests()
  jest.clearAllMocks()
})

describe("ShellJobCard", () => {
  it("streams the run's output and offers background and stop while it runs", async () => {
    const wait = jest
      .fn()
      .mockResolvedValueOnce({
        fromOffset: 0,
        nextOffset: 6,
        data: "hello\n",
        status: "running",
        hasMore: false,
      })
      .mockReturnValue(new Promise(() => {}))
    const { run } = startRun({ wait })
    render(<ShellJobCard run={run} />)

    expect(screen.getByText("$ pnpm build")).toBeTruthy()
    expect(screen.getByText("/work")).toBeTruthy()
    await waitFor(() => expect(screen.getByRole("log").textContent).toBe("hello\n"))
    expect(screen.getByText("running")).toBeTruthy()
    expect(screen.getByRole("button", { name: "moveToBackground" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "stop" })).toBeTruthy()
  })

  it("shows a waiting line before any output", () => {
    const { run } = startRun({ wait: jest.fn().mockReturnValue(new Promise(() => {})) })
    render(<ShellJobCard run={run} />)
    expect(screen.getByRole("log").textContent).toBe("waiting")
  })

  it("stops the job from the Stop button", async () => {
    const kill = jest.fn().mockResolvedValue({})
    const { run } = startRun({ wait: jest.fn().mockReturnValue(new Promise(() => {})), kill })
    render(<ShellJobCard run={run} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "stop" }))
    })
    expect(kill).toHaveBeenCalledWith("job-1")
    expect(screen.getByText("stopping")).toBeTruthy()
  })

  it("toasts when the stop is refused", async () => {
    const kill = jest.fn().mockRejectedValue(new Error("denied"))
    const { run } = startRun({ wait: jest.fn().mockReturnValue(new Promise(() => {})), kill })
    render(<ShellJobCard run={run} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "stop" }))
    })
    expect(toastError).toHaveBeenCalledWith('stopFailed:{"cmd":"pnpm build","error":"denied"}')
  })

  it("hands the job to the background and drops its controls", async () => {
    const { run, upsert } = startRun({
      wait: jest.fn().mockReturnValue(new Promise(() => {})),
      list: jest.fn().mockReturnValue(new Promise(() => {})),
    })
    render(<ShellJobCard run={run} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "moveToBackground" }))
    })
    expect(upsert).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ parts: [{ type: "text", text: "pnpm build moved" }] })
    )
    expect(screen.queryByRole("button", { name: "stop" })).toBeNull()
  })
})

describe("ShellJobView", () => {
  it("renders the run already following the job", () => {
    const { run } = startRun({ wait: jest.fn().mockReturnValue(new Promise(() => {})) })
    render(<ShellJobView block={block} />)
    expect(getShellJobRun("job-1")).toBe(run)
    expect(screen.getByTestId("shell-job-card").getAttribute("data-phase")).toBe("running")
  })

  it("re-attaches a card with no run and shows a job it cannot see as detached", async () => {
    // No run registered and a Host that cannot list the job: the card says so
    // instead of claiming the job failed.
    render(<ShellJobView block={block} />)
    await waitFor(() => expect(screen.getByTestId("shell-job-detached")).toBeTruthy())
    expect(screen.getByText("detached")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "stop" })).toBeNull()
  })
})
