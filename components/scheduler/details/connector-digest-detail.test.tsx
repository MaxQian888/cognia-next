/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const getTask = jest.fn()
const findSession = jest.fn()
const setActiveSession = jest.fn()
const setSelectedGuild = jest.fn()
const toastError = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/lib/scheduler/scheduler-data-source", () => ({
  getSchedulerDataSource: () => ({ getTask }),
}))
jest.mock("@/lib/connectors/session-bindings", () => ({
  findActiveSessionForConversation: (...args: unknown[]) => findSession(...args),
}))
jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: () => ({ setActiveSession }) },
}))
jest.mock("@/stores/ui", () => ({
  useUIStore: { getState: () => ({ setSelectedGuild }) },
}))
jest.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))
jest.mock("@/hooks/scheduler/use-unified-recent-runs", () => ({
  useUnifiedRecentRuns: () => ({ runs: [] }),
}))

import { ConnectorDigestDetail } from "./connector-digest-detail"

beforeEach(() => {
  jest.clearAllMocks()
  getTask.mockResolvedValue({
    id: "task-1",
    type: "connection:scheduled:digest",
    payload: { adapterId: "a1", conversationKey: "discord:a1:c1", prompt: "Daily digest" },
    trigger: { type: "cron", cronExpression: "0 9 * * *" },
    nextRunAt: new Date("2026-07-31T01:00:00.000Z"),
  })
})

it("loads the task through the active scheduler host and opens its source conversation", async () => {
  findSession.mockResolvedValue({ id: "session-1" })
  render(<ConnectorDigestDetail taskId="task-1" />)

  const source = await screen.findByRole("button", { name: /discord:a1:c1/ })
  fireEvent.click(source)

  await waitFor(() => expect(findSession).toHaveBeenCalledWith("discord:a1:c1"))
  expect(getTask).toHaveBeenCalledWith("task-1")
  expect(setActiveSession).toHaveBeenCalledWith("session-1")
  expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "dm" })
})

it("reports when the source conversation no longer has a bound session", async () => {
  findSession.mockResolvedValue(undefined)
  render(<ConnectorDigestDetail taskId="task-1" />)

  fireEvent.click(await screen.findByRole("button", { name: /discord:a1:c1/ }))

  await waitFor(() => expect(toastError).toHaveBeenCalledWith("sourceConversationMissing"))
})
