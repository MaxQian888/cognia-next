import { render, waitFor } from "@testing-library/react"

const interruptRendererBackgroundTasksOnBoot = jest.fn(async (): Promise<unknown[]> => [])
const setRendererBackgroundSettleListener = jest.fn()
const registerBackgroundResultNotifyStrings = jest.fn(() => jest.fn())
const onBackgroundRunSettled = jest.fn()
const redispatchBackgroundRun = jest.fn(async (): Promise<unknown> => ({
  ok: true,
  runId: "new-1",
}))
const pruneBackgroundTaskRecords = jest.fn(async () => 0)
const getSettings = jest.fn(async (): Promise<Record<string, unknown>> => ({}))
const notify = jest.fn(async () => "n1")

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    `${key}${values ? `:${JSON.stringify(values)}` : ""}`,
}))
jest.mock("@/lib/background-tasks/renderer-subagent-registry", () => ({
  interruptRendererBackgroundTasksOnBoot: (...args: unknown[]) =>
    interruptRendererBackgroundTasksOnBoot(...(args as [])),
  setRendererBackgroundSettleListener: (...args: unknown[]) =>
    setRendererBackgroundSettleListener(...(args as [])),
}))
jest.mock("@/hooks/chat/background-result-runtime", () => ({
  onBackgroundRunSettled: (...args: unknown[]) => onBackgroundRunSettled(...(args as [])),
  registerBackgroundResultNotifyStrings: (...args: unknown[]) =>
    registerBackgroundResultNotifyStrings(...(args as [])),
}))
jest.mock("@/lib/background-tasks/redispatch", () => ({
  DEFAULT_MAX_AUTO_RESUME_ATTEMPTS: 2,
  redispatchBackgroundRun: (...args: unknown[]) => redispatchBackgroundRun(...(args as [])),
}))
jest.mock("@/lib/db/background-tasks", () => ({
  pruneBackgroundTaskRecords: (...args: unknown[]) => pruneBackgroundTaskRecords(...(args as [])),
}))
jest.mock("@/lib/db/settings", () => ({
  getSettings: (...args: unknown[]) => getSettings(...(args as [])),
}))
jest.mock("@/lib/notifications/runtime", () => ({
  notify: (...args: unknown[]) => notify(...(args as [])),
}))

import { BackgroundTaskInitializer } from "./background-task-initializer"

const interruptedRow = (over: Record<string, unknown> = {}) => ({
  runId: "stale-1",
  kind: "subagent",
  subagentId: "explore",
  prompt: "look around",
  sessionId: "chat-1",
  host: "renderer",
  status: "interrupted",
  startedAt: 1000,
  settledAt: 2000,
  mode: "background",
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  interruptRendererBackgroundTasksOnBoot.mockResolvedValue([])
  getSettings.mockResolvedValue({})
  redispatchBackgroundRun.mockResolvedValue({ ok: true, runId: "new-1" })
})

it("reconciles renderer background tasks and prunes history on client boot", async () => {
  const { container } = render(<BackgroundTaskInitializer />)

  expect(container).toBeEmptyDOMElement()
  await waitFor(() => expect(interruptRendererBackgroundTasksOnBoot).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(pruneBackgroundTaskRecords).toHaveBeenCalledTimes(1))
})

it("wires the settle listener + localized notify copy, and unwires on unmount", async () => {
  const { unmount } = render(<BackgroundTaskInitializer />)

  // The registered listener is the mocked module's wrapper — assert it
  // forwards to onBackgroundRunSettled rather than comparing identities.
  const listener = setRendererBackgroundSettleListener.mock.calls[0][0] as (
    ...args: unknown[]
  ) => void
  expect(typeof listener).toBe("function")
  listener("r1", { kind: "subagent" }, { status: "done" })
  expect(onBackgroundRunSettled).toHaveBeenCalledWith(
    "r1",
    { kind: "subagent" },
    { status: "done" }
  )
  expect(registerBackgroundResultNotifyStrings).toHaveBeenCalledTimes(1)
  const strings = registerBackgroundResultNotifyStrings.mock.calls[0][0] as unknown as {
    title: (p: { subagentId: string; status: string; elapsed: string }) => string
    body: (p: { runId: string }) => string
  }
  expect(strings.title({ subagentId: "explore", status: "done", elapsed: "3s" })).toContain(
    "doneTitle"
  )
  expect(strings.title({ subagentId: "explore", status: "error", elapsed: "3s" })).toContain(
    "failedTitle"
  )
  expect(strings.body({ runId: "r1" })).toContain("body")

  unmount()
  expect(setRendererBackgroundSettleListener).toHaveBeenLastCalledWith(undefined)
})

it("does not auto-resume when the setting is off (default)", async () => {
  interruptRendererBackgroundTasksOnBoot.mockResolvedValue([interruptedRow()])
  render(<BackgroundTaskInitializer />)

  await waitFor(() => expect(interruptRendererBackgroundTasksOnBoot).toHaveBeenCalled())
  await new Promise((r) => setTimeout(r, 0))
  expect(redispatchBackgroundRun).not.toHaveBeenCalled()
})

it("auto-resumes this boot's interrupted background subagent runs when opted in", async () => {
  interruptRendererBackgroundTasksOnBoot.mockResolvedValue([
    interruptedRow(),
    interruptedRow({ runId: "fg-1", mode: "foreground" }), // foreground rows never auto-resume
    interruptedRow({ runId: "plugin-1", kind: "plugin-agent" }), // non-subagent kinds skipped
  ])
  getSettings.mockResolvedValue({
    backgroundTasks: { autoResumeInterrupted: true, maxAutoResumeAttempts: 3 },
  })

  render(<BackgroundTaskInitializer />)

  await waitFor(() => expect(redispatchBackgroundRun).toHaveBeenCalledTimes(1))
  expect(redispatchBackgroundRun).toHaveBeenCalledWith(
    expect.objectContaining({ runId: "stale-1" }),
    { kind: "auto", maxAutoResumeAttempts: 3 }
  )
  await waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
  expect(notify).toHaveBeenCalledWith(
    expect.objectContaining({ dedupeKey: "background-auto-resume" })
  )
})

it("skips the summary notification when nothing was resumed", async () => {
  interruptRendererBackgroundTasksOnBoot.mockResolvedValue([interruptedRow()])
  getSettings.mockResolvedValue({ backgroundTasks: { autoResumeInterrupted: true } })
  redispatchBackgroundRun.mockResolvedValue({ ok: false, reason: "attempt-cap", message: "capped" })

  render(<BackgroundTaskInitializer />)

  await waitFor(() => expect(redispatchBackgroundRun).toHaveBeenCalled())
  await new Promise((r) => setTimeout(r, 0))
  expect(notify).not.toHaveBeenCalled()
})
