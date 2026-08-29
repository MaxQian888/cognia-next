import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// jsdom reports zero height for the scroll container, so the real virtualizer
// renders nothing. The repo convention is to mock it wholesale.
jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 46,
        size: 46,
        end: (index + 1) * 46,
        lane: 0,
      })),
    getTotalSize: () => count * 46,
    measureElement: jest.fn(),
    scrollToIndex: jest.fn(),
  }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  useFormatter: () => ({
    relativeTime: () => "3 minutes ago",
    dateTime: () => "12:04:31",
  }),
  useNow: () => new Date(1_700_000_000_000),
}))

const copy = jest.fn(async () => true)
jest.mock("@/hooks/ui", () => ({ useCopy: () => ({ copy, copied: false, isCopying: false }) }))

// The journal no longer receives a flat array of every operation's events; an
// expanded row runs its own single-operation live query.
const operationEvents = jest.fn(() => [] as SiteOperationEventRow[])
jest.mock("@/hooks/sites/use-site-operation-events", () => ({
  useSiteOperationEvents: (operationId: string | null) => operationEvents(operationId),
}))

import type { SiteOperationEventRow, SiteOperationRow } from "@/types/sites"
import { SiteOperationJournal, SiteOperationTimeline } from "./site-operation-timeline"

function operation(
  overrides: Partial<SiteOperationRow> & Pick<SiteOperationRow, "id">
): SiteOperationRow {
  return {
    siteId: "site_1",
    type: "build",
    executionTargetKey: "local",
    idempotencyKey: overrides.id,
    inputDigest: "d",
    status: "succeeded",
    attemptCount: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function event(
  overrides: Partial<SiteOperationEventRow> & Pick<SiteOperationEventRow, "id" | "operationId">
): SiteOperationEventRow {
  return { sequence: 1, type: "queued", createdAt: 1, ...overrides }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("SiteOperationTimeline", () => {
  it("renders every event with its sequence, label, and message", () => {
    render(
      <SiteOperationTimeline
        events={[
          event({ id: "e1", operationId: "op1", sequence: 1, type: "queued" }),
          event({
            id: "e2",
            operationId: "op1",
            sequence: 2,
            type: "failed",
            message: "wrangler exited 1",
          }),
        ]}
      />
    )
    expect(screen.getByText("01")).toBeInTheDocument()
    expect(screen.getByText("02")).toBeInTheDocument()
    expect(screen.getByText("operationEvent.queued")).toBeInTheDocument()
    expect(screen.getByText("wrangler exited 1")).toBeInTheDocument()
  })

  it("says so when an operation recorded no events", () => {
    render(<SiteOperationTimeline events={[]} />)
    expect(screen.getByText("operations.noEvents")).toBeInTheDocument()
  })
})

describe("SiteOperationJournal", () => {
  it("shows the empty state when nothing has run", () => {
    render(<SiteOperationJournal operations={[]} events={[]} />)
    expect(screen.getByText("operations.empty")).toBeInTheDocument()
  })

  it("lists operations newest first with status and attempt count", () => {
    render(
      <SiteOperationJournal
        operations={[
          operation({ id: "old", type: "build", updatedAt: 10 }),
          operation({ id: "new", type: "deploy", updatedAt: 90, attemptCount: 3 }),
        ]}
      />
    )
    const rows = screen.getAllByRole("button")
    expect(rows[0]).toHaveAttribute("data-testid", "site-operation-new")
    expect(screen.getByText('operations.attempts:{"count":3}')).toBeInTheDocument()
    expect(screen.getAllByText("operationStatus.succeeded")).toHaveLength(2)
  })

  it("surfaces the failure message that used to be dropped entirely", () => {
    render(
      <SiteOperationJournal
        operations={[operation({ id: "op1", status: "failed", errorMessage: "install failed" })]}
      />
    )
    expect(screen.getByText("install failed")).toBeInTheDocument()
  })

  it("shows the failure message the operation row carries", () => {
    // The old events fallback is gone: `failSiteOperation` and
    // `markSiteOperationForReconcile` both write `errorMessage` in the same
    // transaction that appends the event, so reading events for this cost the
    // console every operation's stream for a value already on the row.
    render(
      <SiteOperationJournal
        operations={[
          operation({
            id: "op1",
            status: "waiting-reconcile",
            errorMessage: "provider timeout",
          }),
        ]}
      />
    )
    expect(screen.getByText("provider timeout")).toBeInTheDocument()
  })

  it("reveals the provider request id and event stream on expand", async () => {
    const user = userEvent.setup()
    render(
      <SiteOperationJournal
        operations={[operation({ id: "op1", providerRequestId: "cf-req-7" })]}
      />
    )
    expect(screen.queryByTestId("site-operation-events")).not.toBeInTheDocument()
    // Collapsed: Radix has not mounted the rail, so no event query ran at all.
    expect(operationEvents).not.toHaveBeenCalled()

    operationEvents.mockReturnValue([event({ id: "e1", operationId: "op1", message: "queued it" })])
    await user.click(screen.getByTestId("site-operation-op1"))

    expect(operationEvents).toHaveBeenCalledWith("op1")

    expect(screen.getByText("cf-req-7")).toBeInTheDocument()
    expect(screen.getByTestId("site-operation-events")).toBeInTheDocument()
    expect(screen.getByText("queued it")).toBeInTheDocument()
  })

  it("copies the provider request id", async () => {
    const user = userEvent.setup()
    render(
      <SiteOperationJournal
        operations={[operation({ id: "op1", providerRequestId: "cf-req-7" })]}
      />
    )
    await user.click(screen.getByTestId("site-operation-op1"))
    await user.click(screen.getByRole("button", { name: "actions.copyUrl" }))
    expect(copy).toHaveBeenCalledWith("cf-req-7")
  })

  it("offers a re-check only when the caller supplies one, and honours the gate", async () => {
    const user = userEvent.setup()
    const onRefresh = jest.fn()
    const { rerender } = render(
      <SiteOperationJournal operations={[operation({ id: "op1", status: "waiting-reconcile" })]} />
    )
    await user.click(screen.getByTestId("site-operation-op1"))
    expect(screen.queryByText("actions.refreshOperation")).not.toBeInTheDocument()

    rerender(
      <SiteOperationJournal
        operations={[operation({ id: "op1", status: "waiting-reconcile" })]}
        onRefresh={onRefresh}
        refreshDisabled
        refreshTitle="needs desktop"
      />
    )
    const button = screen.getByRole("button", { name: /actions.refreshOperation/ })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute("title", "needs desktop")

    rerender(
      <SiteOperationJournal
        operations={[operation({ id: "op1", status: "waiting-reconcile" })]}
        onRefresh={onRefresh}
      />
    )
    await user.click(screen.getByRole("button", { name: /actions.refreshOperation/ }))
    expect(onRefresh).toHaveBeenCalledWith("op1")
  })
})

describe("abandoning a wedged operation", () => {
  it("offers the action only while the operation can still change", async () => {
    const user = userEvent.setup()
    const onCancel = jest.fn()
    render(
      <SiteOperationJournal
        operations={[operation({ id: "stuck", status: "waiting-reconcile" })]}
        onCancel={onCancel}
      />
    )
    await user.click(screen.getByTestId("site-operation-stuck"))
    await user.click(screen.getByTestId("site-operation-cancel-stuck"))
    expect(onCancel).toHaveBeenCalledWith("stuck")
  })

  it.each(["succeeded", "failed", "cancelled"] as const)(
    "hides it for a %s operation, which can no longer change",
    async (status) => {
      const user = userEvent.setup()
      render(
        <SiteOperationJournal
          operations={[operation({ id: "done", status })]}
          onCancel={jest.fn()}
        />
      )
      await user.click(screen.getByTestId("site-operation-done"))
      expect(screen.queryByTestId("site-operation-cancel-done")).not.toBeInTheDocument()
    }
  )

  it("shows nothing when the caller offers no cancel", async () => {
    const user = userEvent.setup()
    render(<SiteOperationJournal operations={[operation({ id: "stuck", status: "queued" })]} />)
    await user.click(screen.getByTestId("site-operation-stuck"))
    expect(screen.queryByTestId("site-operation-cancel-stuck")).not.toBeInTheDocument()
  })
})
