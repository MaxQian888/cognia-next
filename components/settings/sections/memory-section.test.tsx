/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

import type { MemoryInsights } from "@/hooks/memory/use-memory-insights"
import type { MemoryConfig } from "@/types/memory/memory"
import { MemorySection } from "./memory-section"

const mockSave = jest.fn()
let mockSettings: { memory?: Partial<MemoryConfig> } | null = { memory: {} }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: mockSettings, save: mockSave }),
}))

const mockInsights: MemoryInsights = {
  corpus: {
    stats: {
      total: 3,
      active: 3,
      pinned: 0,
      conflicts: 1,
      byType: { semantic: 1, episodic: 1, procedural: 1 },
    },
    byScope: { global: 1, workspace: 1, character: 1, agent: 0 },
    vector: { embedded: 2, active: 3, coverage: 2 / 3 },
    averageTokens: 30,
  },
  jobs: [],
  maintenance: undefined,
  maintenanceWindowStart: 0,
  retrievalMode: { kind: "bm25", reason: "hybrid_disabled" },
  loading: false,
  refreshRetrievalMode: jest.fn(),
}
jest.mock("@/hooks/memory/use-memory-insights", () => ({
  useMemoryInsights: () => mockInsights,
}))
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: true, durationScale: 1 }),
  MotionCollapse: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
}))

beforeEach(() => {
  jest.clearAllMocks()
  mockSettings = { memory: {} }
})

describe("MemorySection", () => {
  it("renders the overview and saves the master toggle", () => {
    render(<MemorySection />)

    expect(screen.getByRole("heading", { name: "Overview" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("switch", { name: "Enable long-term memory" }))
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ memory: expect.objectContaining({ enabled: false }) })
    )
  })

  it("switches between all master-detail panels", () => {
    render(<MemorySection />)

    fireEvent.click(screen.getByTestId("memory-nav-item-learning"))
    expect(screen.getByRole("heading", { name: "Learning" })).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "Learn from chats" })).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("memory-nav-item-retrieval"))
    expect(screen.getByRole("heading", { name: "Retrieval" })).toBeInTheDocument()
    expect(screen.getByTestId("memory-recall-preview")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("memory-nav-item-maintenance"))
    expect(screen.getByRole("heading", { name: "Maintenance" })).toBeInTheDocument()
    expect(screen.getByLabelText("Max active memories per scope")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("memory-nav-item-privacy"))
    expect(screen.getByRole("heading", { name: "Privacy" })).toBeInTheDocument()
    expect(screen.getByTestId("memory-danger-zone")).toBeInTheDocument()
  })

  it("saves privacy controls from the mounted privacy panel", () => {
    render(<MemorySection />)
    fireEvent.click(screen.getByTestId("memory-nav-item-privacy"))
    fireEvent.click(screen.getByRole("switch", { name: "Allow cloud embeddings" }))

    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        memory: expect.objectContaining({ allowCloudEmbedding: true }),
      })
    )
  })
})
