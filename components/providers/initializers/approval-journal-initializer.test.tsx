import { render, waitFor } from "@testing-library/react"

import type { NotificationInput } from "@/types/notifications"

const notify = jest.fn<Promise<string>, [NotificationInput]>(async () => "n1")
type Row = { requestId: string; status: string; notifiedAt?: number }
let entries: Row[] = []
const markNotified = jest.fn((ids: readonly string[], at: number) => {
  entries = entries.map((e) =>
    ids.includes(e.requestId) && e.notifiedAt === undefined ? { ...e, notifiedAt: at } : e
  )
})
let mainWindow = true

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    `${key}${values ? `:${JSON.stringify(values)}` : ""}`,
}))
jest.mock("@/stores/agent/approval-journal-store", () => ({
  ...jest.requireActual("@/stores/agent/approval-journal-store"),
  useApprovalJournalStore: { getState: () => ({ entries, markNotified }) },
}))
jest.mock("@/lib/notifications/runtime", () => ({
  notify: (...args: unknown[]) => notify(...(args as [NotificationInput])),
}))
jest.mock("@/lib/pet/window-role", () => ({ isMainAppWindow: () => mainWindow }))

import { ApprovalJournalInitializer } from "./approval-journal-initializer"

const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  jest.clearAllMocks()
  entries = []
  mainWindow = true
})

it("renders nothing", async () => {
  const { container } = render(<ApprovalJournalInitializer />)
  expect(container).toBeEmptyDOMElement()
  // Let the async boot effect settle so no unhandled work leaks into later tests.
  await settle()
})

it("announces interrupted approvals restored at boot, counting only unannounced ones", async () => {
  entries = [
    { requestId: "a", status: "interrupted" },
    { requestId: "b", status: "interrupted" },
    { requestId: "c", status: "pending" }, // not interrupted → not counted
    { requestId: "d", status: "interrupted", notifiedAt: 1 }, // already announced
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
  expect(notify.mock.calls[0][0].title).toContain('"count":2')
  // Claimed per entry, and the entries stay in the journal (still listed).
  expect(markNotified).toHaveBeenCalledWith(["a", "b"], expect.any(Number))
  expect(entries.map((e) => e.requestId)).toEqual(["a", "b", "c", "d"])
})

it("does not notify when nothing was interrupted", async () => {
  entries = [{ requestId: "a", status: "pending" }]
  render(<ApprovalJournalInitializer />)
  await settle()
  expect(notify).not.toHaveBeenCalled()
  expect(markNotified).not.toHaveBeenCalled()
})

it("does not re-announce on a remount (account unlock, gate re-mount, revisit)", async () => {
  entries = [{ requestId: "a", status: "interrupted" }]
  const first = render(<ApprovalJournalInitializer />)
  await waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
  first.unmount()
  render(<ApprovalJournalInitializer />)
  await settle()
  expect(notify).toHaveBeenCalledTimes(1)
})

it("announces an entry interrupted later, once", async () => {
  entries = [{ requestId: "a", status: "interrupted", notifiedAt: 1 }]
  const first = render(<ApprovalJournalInitializer />)
  await settle()
  expect(notify).not.toHaveBeenCalled()
  first.unmount()
  entries = [...entries, { requestId: "b", status: "interrupted" }]
  render(<ApprovalJournalInitializer />)
  await waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
  expect(notify.mock.calls[0][0].title).toContain('"count":1')
})

it("stays quiet in secondary windows, which mount the same layout", async () => {
  mainWindow = false
  entries = [{ requestId: "a", status: "interrupted" }]
  render(<ApprovalJournalInitializer />)
  await settle()
  expect(notify).not.toHaveBeenCalled()
  // Left unannounced for the main window to report.
  expect(markNotified).not.toHaveBeenCalled()
})

it("keeps the claim when the notification runtime fails (best-effort)", async () => {
  notify.mockRejectedValueOnce(new Error("no notifier"))
  entries = [{ requestId: "a", status: "interrupted" }]
  render(<ApprovalJournalInitializer />)
  await waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
  expect(entries[0]!.notifiedAt).toEqual(expect.any(Number))
})
