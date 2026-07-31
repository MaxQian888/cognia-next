/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

import type { MemoryInsights } from "@/hooks/memory/use-memory-insights"
import { DEFAULT_MEMORY_CONFIG } from "@/types/memory/memory"
import { RetrievalPanel } from "./retrieval-panel"

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: true, durationScale: 1 }),
}))

const insights: MemoryInsights = {
  corpus: {
    stats: {
      total: 2,
      active: 2,
      pinned: 0,
      conflicts: 0,
      byType: { semantic: 1, episodic: 1, procedural: 0 },
    },
    byScope: { global: 1, workspace: 1, character: 0, agent: 0 },
    vector: { embedded: 0, active: 2, coverage: 0 },
    averageTokens: 24,
  },
  jobs: [],
  maintenance: undefined,
  maintenanceWindowStart: 0,
  retrievalMode: { kind: "bm25", reason: "hybrid_disabled" },
  loading: false,
  refreshRetrievalMode: jest.fn(),
}

describe("RetrievalPanel", () => {
  it("updates the recall and hybrid switches", () => {
    const update = jest.fn()
    render(<RetrievalPanel config={DEFAULT_MEMORY_CONFIG} update={update} insights={insights} />)

    fireEvent.click(screen.getByRole("switch", { name: "Use memories" }))
    fireEvent.click(screen.getByRole("button", { name: "Enable hybrid retrieval" }))

    expect(update).toHaveBeenCalledWith({ useMemory: false })
    expect(update).toHaveBeenCalledWith({ hybridEnabled: true })
  })

  it("gates retrieval tuning when recall is disabled", () => {
    render(
      <RetrievalPanel
        config={{ ...DEFAULT_MEMORY_CONFIG, useMemory: false }}
        update={jest.fn()}
        insights={insights}
      />
    )

    expect(screen.getByTestId("memory-gate-reason")).toHaveTextContent("Turn on memory recall")
    expect(
      screen.getByRole("switch", { name: "Hybrid retrieval" }).closest("[inert]")
    ).not.toBeNull()
  })
})
