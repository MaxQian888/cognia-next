/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    `${key}:${vars?.count ?? ""}`,
}))
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))
jest.mock("@/components/ui/tooltip")

const rows = jest.fn(async (): Promise<Array<{ status: string }>> => [])
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    executionRunBindings: {
      where: () => ({ equals: () => ({ toArray: () => rows() }) }),
    },
  }),
}))

import { ActiveDelegationsChip } from "./active-delegations-chip"

beforeEach(() => rows.mockReset().mockResolvedValue([]))

// The common case by far. A chip that renders "0 runs" on every conversation
// would be pure noise in a popover that already carries eight controls.
it("renders nothing when no run is in flight", async () => {
  const { container } = render(<ActiveDelegationsChip conversationKey="telegram:tg-1:9" />)
  await waitFor(() => expect(rows).toHaveBeenCalled())
  expect(container).toBeEmptyDOMElement()
})

it("counts only the live bindings and links to the cockpit", async () => {
  rows.mockResolvedValue([
    { status: "active" },
    { status: "completed" },
    { status: "disabled" },
    { status: "active" },
  ])
  render(<ActiveDelegationsChip conversationKey="telegram:tg-1:9" />)
  const chip = await screen.findByTestId("active-delegations-chip")
  expect(chip).toHaveAttribute("data-count", "2")
  expect(chip.closest("a")).toHaveAttribute("href", "/agent-runs")
})

// `/agent-runs` alone opens the list with nothing selected. One live run is
// unambiguous, so the chip names it.
it("deep-links to the run itself when exactly one is live", async () => {
  rows.mockResolvedValue([{ status: "active", runId: "run_1" }])
  render(<ActiveDelegationsChip conversationKey="telegram:tg-1:9" />)
  const chip = await screen.findByTestId("active-delegations-chip")
  expect(chip.closest("a")).toHaveAttribute("href", "/agent-runs?run=run_1")
})

it("falls back to the list when several are live, because the list is the answer", async () => {
  rows.mockResolvedValue([
    { status: "active", runId: "run_1" },
    { status: "degraded", runId: "run_2" },
  ])
  render(<ActiveDelegationsChip conversationKey="telegram:tg-1:9" />)
  const chip = await screen.findByTestId("active-delegations-chip")
  expect(chip.closest("a")).toHaveAttribute("href", "/agent-runs")
})

// A binding with no run id cannot be deep-linked, and guessing one would send
// the reader to an empty detail pane.
it("falls back to the list when the single binding has no run id", async () => {
  rows.mockResolvedValue([{ status: "active" }])
  render(<ActiveDelegationsChip conversationKey="telegram:tg-1:9" />)
  const chip = await screen.findByTestId("active-delegations-chip")
  expect(chip.closest("a")).toHaveAttribute("href", "/agent-runs")
})

// A degraded run is still running. Hiding it would take away the one route to
// the cockpit at exactly the moment the thread stopped reporting progress.
it("counts a degraded run as live", async () => {
  rows.mockResolvedValue([{ status: "degraded" }])
  render(<ActiveDelegationsChip conversationKey="telegram:tg-1:9" />)
  await waitFor(() =>
    expect(screen.getByTestId("active-delegations-chip")).toHaveAttribute("data-count", "1")
  )
})

it("renders nothing when every binding has settled", async () => {
  rows.mockResolvedValue([{ status: "completed" }, { status: "disabled" }])
  const { container } = render(<ActiveDelegationsChip conversationKey="telegram:tg-1:9" />)
  await waitFor(() => expect(rows).toHaveBeenCalled())
  expect(container).toBeEmptyDOMElement()
})
