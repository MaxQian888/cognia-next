/** @jest-environment jsdom */

/**
 * The Control Center's fourth source: durable `executionRunInterrupts`.
 *
 * Isolated from `attention-panel.test.tsx` because it drives the panel from a
 * mocked aggregation hook rather than through the real stores — the run source
 * is a Dexie liveQuery, and seeding IndexedDB into the shared file would change
 * how its other thirty tests boot.
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"

const pushMock = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}))

jest.mock("@/stores/ui/ui-store", () => ({
  useUIStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ setSelectedGuild: jest.fn() }),
}))

let items: AttentionItem[] = []
jest.mock("@/hooks/attention/use-attention", () => ({
  useAttentionItems: () => items,
  useAttentionCount: () => items.filter((item) => !item.stale).length,
}))

import { AttentionPanel } from "./attention-panel"
import type { AttentionItem } from "@/lib/attention/types"

function runItem(over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "run:i1",
    source: "run",
    kind: "run-approval",
    title: "Bash",
    openedAt: 1,
    stale: false,
    runId: "execution:job:abc",
    ...over,
  }
}

function renderPanel() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AttentionPanel />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  pushMock.mockReset()
  items = []
})

describe("AttentionPanel — durable run approvals", () => {
  it("labels a run approval with its own source", () => {
    items = [runItem()]
    renderPanel()
    fireEvent.click(screen.getByTestId("attention-trigger"))
    const row = screen.getByTestId("attention-row-run:i1")
    expect(row).toHaveTextContent("Run")
    expect(row).toHaveTextContent("Bash")
  })

  it("counts a live run approval in the badge", () => {
    items = [runItem()]
    renderPanel()
    expect(screen.getByTestId("attention-count")).toHaveTextContent("1")
  })

  /**
   * Answered at the run, not here: the cockpit holds the revision, the pending
   * interrupt id and the control plane. An inline button would re-derive all three.
   */
  it("deep-links into the cockpit for the run that is blocked", () => {
    items = [runItem()]
    renderPanel()
    fireEvent.click(screen.getByTestId("attention-trigger"))
    fireEvent.click(screen.getByTestId("attention-open-run-run:i1"))
    expect(pushMock).toHaveBeenCalledWith("/agent-runs?run=execution%3Ajob%3Aabc")
  })

  it("offers no open affordance for a stale row", () => {
    items = [runItem({ stale: true })]
    renderPanel()
    fireEvent.click(screen.getByTestId("attention-trigger"))
    expect(screen.queryByTestId("attention-open-run-run:i1")).not.toBeInTheDocument()
  })

  it("does not offer a dead link for an interrupt with no run", () => {
    items = [runItem({ runId: undefined })]
    renderPanel()
    fireEvent.click(screen.getByTestId("attention-trigger"))
    expect(screen.queryByTestId("attention-open-run-run:i1")).not.toBeInTheDocument()
  })
})
