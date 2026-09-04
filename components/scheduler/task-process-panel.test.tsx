/** @jest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import { TaskProcessPanel } from "./task-process-panel"
import type { TaskProcesses } from "@/lib/scheduler/task-processes"

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const messages = {
  scheduler: {
    processes: {
      title: "Processes",
      none: "Nothing is running for this task right now.",
      stop: "Stop",
      stopped: "Stopped",
      stopFailed: "Could not stop it",
      pid: "PID {pid}",
      noPid: "No PID recorded",
      exitCode: "exit {code}",
      watching: "Watching: {condition}",
    },
  },
}

function renderPanel(props: Partial<React.ComponentProps<typeof TaskProcessPanel>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TaskProcessPanel
        taskId="task-1"
        taskType="background-command"
        loadProcesses={async () => ({ supported: true, jobs: [], monitors: [] })}
        {...props}
      />
    </NextIntlClientProvider>
  )
}

const job = (overrides: Record<string, unknown> = {}) => ({
  id: "job-1",
  command: "pnpm build",
  cwd: "/repo",
  owner: { kind: "scheduledTask", taskId: "task-1" },
  status: "running",
  pid: 4242,
  startedAtMs: 1,
  totalOutputBytes: 0,
  droppedOutputBytes: 0,
  ...overrides,
})

const monitor = (overrides: Record<string, unknown> = {}) => ({
  id: "mon-1",
  condition: { kind: "jobExit", jobId: "job-1" },
  owner: { kind: "scheduledTask", taskId: "task-1" },
  status: "waiting",
  createdAtMs: 1,
  ...overrides,
})

// An empty "Processes" heading under every chat task would be noise, and worse,
// it would imply the question had been asked and answered for a task type that
// can never have one.
it("renders nothing for a task type that cannot spawn a process", async () => {
  const loadProcesses = jest.fn()
  renderPanel({ taskType: "chat", loadProcesses })

  await waitFor(() => expect(screen.queryByTestId("task-process-panel")).not.toBeInTheDocument())
  expect(loadProcesses).not.toHaveBeenCalled()
})

it("lists a running job with its PID and a stop button", async () => {
  renderPanel({
    loadProcesses: async () => ({ supported: true, jobs: [job()], monitors: [] }) as TaskProcesses,
  })

  expect(await screen.findByTestId("task-process-job")).toBeInTheDocument()
  expect(screen.getByText("pnpm build")).toBeInTheDocument()
  // The PID is the reason to render this at all: it is what a user needs to
  // find the process outside the app.
  expect(screen.getByText(/PID 4242/)).toBeInTheDocument()
  expect(screen.getByTestId("task-process-kill")).toBeInTheDocument()
})

it("offers no stop button on a job that already exited", async () => {
  renderPanel({
    loadProcesses: async () =>
      ({
        supported: true,
        jobs: [job({ status: "exited", exitCode: 0 })],
        monitors: [],
      }) as TaskProcesses,
  })

  expect(await screen.findByTestId("task-process-job")).toBeInTheDocument()
  expect(screen.queryByTestId("task-process-kill")).not.toBeInTheDocument()
  expect(screen.getByText(/exit 0/)).toBeInTheDocument()
})

it("kills the job it names when Stop is pressed", async () => {
  const onKillJob = jest.fn().mockResolvedValue({ id: "job-1", status: "killed" })
  renderPanel({
    loadProcesses: async () => ({ supported: true, jobs: [job()], monitors: [] }) as TaskProcesses,
    onKillJob,
  })

  await userEvent.click(await screen.findByTestId("task-process-kill"))
  expect(onKillJob).toHaveBeenCalledWith("job-1")
})

it("cancels a waiting monitor without touching the job it watches", async () => {
  const onCancelMonitor = jest.fn().mockResolvedValue({ id: "mon-1", status: "cancelled" })
  const onKillJob = jest.fn()
  renderPanel({
    loadProcesses: async () =>
      ({ supported: true, jobs: [], monitors: [monitor()] }) as TaskProcesses,
    onCancelMonitor,
    onKillJob,
  })

  await userEvent.click(await screen.findByTestId("task-process-cancel-monitor"))
  expect(onCancelMonitor).toHaveBeenCalledWith("mon-1")
  expect(onKillJob).not.toHaveBeenCalled()
})

// The distinction the panel exists to preserve. On a phone, an empty list
// would read as "the desktop's command finished".
it("says a host cannot answer instead of showing an empty list", async () => {
  renderPanel({
    loadProcesses: async () => ({ supported: false, reason: "No supervisor on this host." }),
  })

  expect(await screen.findByTestId("task-process-unsupported")).toHaveTextContent(
    "No supervisor on this host."
  )
  expect(screen.queryByTestId("task-process-empty")).not.toBeInTheDocument()
})

it("says nothing is running when the host answered with an empty list", async () => {
  renderPanel()

  expect(await screen.findByTestId("task-process-empty")).toBeInTheDocument()
  expect(screen.queryByTestId("task-process-unsupported")).not.toBeInTheDocument()
})

it("keeps rendering when the loader throws", async () => {
  renderPanel({
    loadProcesses: jest.fn().mockRejectedValue(new Error("boom")),
  })

  // No crash, and no half-rendered list. The detail view around it survives.
  await waitFor(() => expect(screen.queryByTestId("task-process-job")).not.toBeInTheDocument())
})
