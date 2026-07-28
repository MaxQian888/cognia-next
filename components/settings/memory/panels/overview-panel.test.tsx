/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

import type { MemoryInsights } from "@/hooks/memory/use-memory-insights"
import { OverviewPanel } from "./overview-panel"

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: true, speed: 1 }),
}))

const insights: MemoryInsights = {
  corpus: {
    stats: {
      total: 12,
      active: 10,
      pinned: 2,
      conflicts: 3,
      byType: { semantic: 4, episodic: 3, procedural: 3 },
    },
    byScope: { global: 5, workspace: 3, character: 1, agent: 1 },
    vector: { embedded: 8, active: 10, coverage: 0.8 },
    averageTokens: 32,
  },
  jobs: [],
  maintenance: undefined,
  maintenanceWindowStart: 0,
  retrievalMode: { kind: "bm25", reason: "cloud_blocked", provider: "openai" },
  loading: false,
  refreshRetrievalMode: jest.fn(),
}

describe("OverviewPanel", () => {
  it("renders corpus health and vector coverage", () => {
    render(
      <OverviewPanel
        insights={insights}
        onEnableHybrid={jest.fn()}
        onAllowCloudEmbedding={jest.fn()}
      />
    )

    expect(screen.getByTestId("memory-stat-active")).toHaveTextContent("10")
    expect(screen.getByTestId("memory-stat-conflicts")).toHaveTextContent("3")
    expect(screen.getByRole("meter", { name: "Vector coverage" })).toHaveAttribute(
      "aria-valuenow",
      "80"
    )
    expect(screen.getByRole("link", { name: "Open memory manager" })).toHaveAttribute(
      "href",
      "/memory"
    )
  })

  it("offers the action that repairs cloud-blocked retrieval", () => {
    const onAllowCloudEmbedding = jest.fn()
    render(
      <OverviewPanel
        insights={insights}
        onEnableHybrid={jest.fn()}
        onAllowCloudEmbedding={onAllowCloudEmbedding}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Allow cloud embeddings" }))
    expect(onAllowCloudEmbedding).toHaveBeenCalledTimes(1)
  })
})
