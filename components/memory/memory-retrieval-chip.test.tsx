/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { MemoryRetrievalMode } from "@/lib/memory/runtime/build-deps"
import { MemoryRetrievalChip } from "./memory-retrieval-chip"

let snapshot: unknown = {
  runtime: { killSwitchEngaged: false },
  generations: [],
  jobs: [],
  traces: [],
}
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => snapshot }))
jest.mock("@/lib/db/retrieval-control", () => ({
  listRetrievalControlSnapshot: jest.fn(),
}))
jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn(async () => ({})) }))

const mockDescribe = jest.fn<Promise<MemoryRetrievalMode>, unknown[]>(async () => ({
  kind: "hybrid",
  provider: "local",
}))
jest.mock("@/lib/memory/runtime/build-deps", () => ({
  describeMemoryRetrievalMode: (...args: unknown[]) => mockDescribe(...args),
}))
jest.mock("@/components/rag/retrieval-control-panel", () => ({
  RetrievalControlPanel: () => <div data-testid="retrieval-control-panel" />,
}))

beforeEach(() => {
  snapshot = { runtime: { killSwitchEngaged: false }, generations: [], jobs: [], traces: [] }
  mockDescribe.mockClear()
})

describe("MemoryRetrievalChip", () => {
  it("names the recall mode so BM25-only degradation is visible", () => {
    render(<MemoryRetrievalChip mode={{ kind: "hybrid", provider: "local" }} />)
    expect(screen.getByTestId("memory-retrieval-chip").textContent).toContain("Hybrid recall")
  })

  // The visible label collapses in a tight header, so the state has to survive
  // in the accessible name or the chip becomes an unlabelled icon.
  it("keeps the recall state in its accessible name when the label is hidden", () => {
    render(<MemoryRetrievalChip mode={{ kind: "bm25", reason: "no_backend" }} />)
    expect(screen.getByRole("button", { name: "Keyword recall — Retrieval controls" })).toBeTruthy()
  })

  it("says keyword-only when the vector backend is unavailable", () => {
    render(<MemoryRetrievalChip mode={{ kind: "bm25", reason: "no_backend" }} />)
    const chip = screen.getByTestId("memory-retrieval-chip")
    expect(chip.textContent).toContain("Keyword recall")
    expect(chip.dataset.tone).toBe("muted")
  })

  it("shows a checking state until the probe resolves", async () => {
    let resolveProbe!: (mode: MemoryRetrievalMode) => void
    mockDescribe.mockImplementationOnce(
      () =>
        new Promise<MemoryRetrievalMode>((resolve) => {
          resolveProbe = resolve
        })
    )
    render(<MemoryRetrievalChip />)
    expect(screen.getByTestId("memory-retrieval-chip").textContent).toContain("Checking recall")
    await waitFor(() => expect(mockDescribe).toHaveBeenCalled())
    resolveProbe({ kind: "hybrid", provider: "local" })
    await waitFor(() =>
      expect(screen.getByTestId("memory-retrieval-chip").textContent).toContain("Hybrid recall")
    )
  })

  it("probes the live backend when no mode is supplied", async () => {
    render(<MemoryRetrievalChip />)
    await waitFor(() =>
      expect(screen.getByTestId("memory-retrieval-chip").textContent).toContain("Hybrid recall")
    )
  })

  // The kill switch outranks the recall mode: when retrieval is stopped, how it
  // would have recalled is not what the user needs to see.
  it("reports the kill switch over the recall mode", () => {
    snapshot = {
      runtime: { killSwitchEngaged: true },
      generations: [],
      jobs: [],
      traces: [],
    }
    render(<MemoryRetrievalChip mode={{ kind: "hybrid", provider: "local" }} />)
    const chip = screen.getByTestId("memory-retrieval-chip")
    expect(chip.textContent).toContain("Recall paused")
    expect(chip.dataset.tone).toBe("danger")
  })

  it("badges in-flight jobs and hides the badge when there are none", () => {
    snapshot = {
      runtime: { killSwitchEngaged: false },
      generations: [],
      jobs: [
        { id: "j1", status: "running" },
        { id: "j2", status: "queued" },
        { id: "j3", status: "succeeded" },
      ],
      traces: [],
    }
    const { unmount } = render(<MemoryRetrievalChip mode={{ kind: "hybrid", provider: "local" }} />)
    expect(screen.getByTestId("memory-retrieval-chip-jobs").textContent).toBe("2")
    unmount()

    snapshot = { runtime: { killSwitchEngaged: false }, generations: [], jobs: [], traces: [] }
    render(<MemoryRetrievalChip mode={{ kind: "hybrid", provider: "local" }} />)
    expect(screen.queryByTestId("memory-retrieval-chip-jobs")).toBeNull()
  })

  // The full panel is one click away rather than a permanent band above the
  // list, which is the whole reason this chip exists.
  it("opens the full control panel in a popover", async () => {
    render(<MemoryRetrievalChip mode={{ kind: "hybrid", provider: "local" }} />)
    expect(screen.queryByTestId("retrieval-control-panel")).toBeNull()
    await userEvent.click(screen.getByTestId("memory-retrieval-chip"))
    expect(await screen.findByTestId("retrieval-control-panel")).toBeTruthy()
  })
})
