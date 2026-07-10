import { render, waitFor } from "@testing-library/react"

const notify = jest.fn(async () => "n1")
let entries: Array<{ requestId: string; status: string }> = []

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    `${key}${values ? `:${JSON.stringify(values)}` : ""}`,
}))
jest.mock("@/stores/agent/approval-journal-store", () => ({
  useApprovalJournalStore: { getState: () => ({ entries }) },
}))
jest.mock("@/lib/notifications/runtime", () => ({
  notify: (...args: unknown[]) => notify(...(args as [])),
}))

import { ApprovalJournalInitializer } from "./approval-journal-initializer"

beforeEach(() => {
  jest.clearAllMocks()
  entries = []
})

it("renders nothing", async () => {
  const { container } = render(<ApprovalJournalInitializer />)
  expect(container).toBeEmptyDOMElement()
  // Let the async boot effect settle so no unhandled work leaks into later tests.
  await waitFor(() => {})
})

it("fires a one-shot boot notice when interrupted approvals were restored", async () => {
  entries = [
    { requestId: "a", status: "interrupted" },
    { requestId: "b", status: "interrupted" },
    { requestId: "c", status: "pending" }, // not interrupted → not counted
  ]
  render(<ApprovalJournalInitializer />)

  await waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
  expect(notify).toHaveBeenCalledWith(
    expect.objectContaining({
      source: "session",
      level: "warning",
      dedupeKey: "approval-journal-interrupted-boot",
      title: expect.stringContaining("interruptedOnBoot"),
    })
  )
  // The count reflects only interrupted entries.
  expect(notify.mock.calls[0][0].title).toContain('"count":2')
})

it("does not notify when nothing was interrupted", async () => {
  entries = [{ requestId: "a", status: "pending" }]
  render(<ApprovalJournalInitializer />)
  await new Promise((r) => setTimeout(r, 0))
  expect(notify).not.toHaveBeenCalled()
})

it("fires at most once even across re-renders", async () => {
  entries = [{ requestId: "a", status: "interrupted" }]
  const { rerender } = render(<ApprovalJournalInitializer />)
  await waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
  rerender(<ApprovalJournalInitializer />)
  await new Promise((r) => setTimeout(r, 0))
  expect(notify).toHaveBeenCalledTimes(1)
})
