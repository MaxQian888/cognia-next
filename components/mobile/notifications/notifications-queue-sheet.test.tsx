/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { NotificationsQueueSheet } from "./notifications-queue-sheet"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      title: "Scheduled notifications",
      refresh: "Refresh",
      empty: "No notifications scheduled",
      unsupportedTitle: "Not supported",
      unsupportedDescription: "Notifications run on iOS/Android only.",
      errorTitle: "Could not load notifications",
      cancel: "Cancel",
      cancelFailed: `Cancel failed: ${(vars?.message as string) ?? ""}`,
      loading: "Loading…",
      scheduledAt: `at ${(vars?.time as string) ?? ""}`,
    }
    return map[key] ?? key
  },
}))

jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn(), info: jest.fn() },
}))

describe("NotificationsQueueSheet", () => {
  it("renders nothing when closed", () => {
    render(<NotificationsQueueSheet open={false} onOpenChange={() => {}} />)
    expect(screen.queryByTestId("notifications-queue-sheet")).toBeNull()
  })

  it("renders empty state when no pending notifications", async () => {
    const lister = jest.fn().mockResolvedValue({ kind: "ok", value: [] })
    render(<NotificationsQueueSheet open onOpenChange={() => {}} lister={lister as never} />)
    expect(await screen.findByText("No notifications scheduled")).toBeInTheDocument()
  })

  it("renders unsupported empty state when wrapper rejects platform", async () => {
    const lister = jest.fn().mockResolvedValue({ kind: "unsupported" })
    render(<NotificationsQueueSheet open onOpenChange={() => {}} lister={lister as never} />)
    expect(await screen.findByText("Not supported")).toBeInTheDocument()
  })

  it("lists pending notifications", async () => {
    const lister = jest.fn().mockResolvedValue({
      kind: "ok",
      value: [
        { id: 1, title: "Backup soon", body: "Auto backup in 5 min" },
        {
          id: 2,
          title: "Scheduler reminder",
          body: "Daily summary",
          schedule: { at: new Date("2026-05-20T09:00:00Z") },
        },
      ],
    })
    render(<NotificationsQueueSheet open onOpenChange={() => {}} lister={lister as never} />)
    expect(await screen.findByTestId("notifications-queue-row-1")).toHaveTextContent("Backup soon")
    expect(screen.getByTestId("notifications-queue-row-2")).toHaveTextContent("Scheduler reminder")
  })

  it("cancels a notification on click", async () => {
    const user = userEvent.setup()
    const lister = jest
      .fn()
      .mockResolvedValueOnce({
        kind: "ok",
        value: [{ id: 7, title: "Test", body: "Body" }],
      })
      .mockResolvedValueOnce({ kind: "ok", value: [] })
    const canceller = jest.fn().mockResolvedValue({ kind: "ok" })
    render(
      <NotificationsQueueSheet
        open
        onOpenChange={() => {}}
        lister={lister as never}
        canceller={canceller as never}
      />
    )
    const cancel = await screen.findByTestId("notifications-queue-cancel-7")
    await user.click(cancel)
    await waitFor(() => expect(canceller).toHaveBeenCalledWith([7]))
    // After refresh, the row should be gone.
    await waitFor(() => expect(screen.queryByTestId("notifications-queue-row-7")).toBeNull())
  })

  it("refresh re-invokes the lister", async () => {
    const user = userEvent.setup()
    const lister = jest.fn().mockResolvedValue({ kind: "ok", value: [] })
    render(<NotificationsQueueSheet open onOpenChange={() => {}} lister={lister as never} />)
    await screen.findByText("No notifications scheduled")
    expect(lister).toHaveBeenCalledTimes(1)
    await user.click(screen.getByTestId("notifications-queue-refresh"))
    await waitFor(() => expect(lister).toHaveBeenCalledTimes(2))
  })
})
