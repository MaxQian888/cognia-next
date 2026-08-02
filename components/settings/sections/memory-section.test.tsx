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

  it("splits nav from detail without wrapping either in a card", () => {
    const { container } = render(<MemorySection />)

    expect(screen.getByTestId("memory-section")).toBeInTheDocument()
    expect(screen.getByTestId("memory-panel-body")).toBeInTheDocument()
    expect(container.querySelector("[data-slot='card']")).toBeNull()
  })

  it("offers the nav through a sheet on narrow viewports", () => {
    render(<MemorySection />)

    fireEvent.click(screen.getByTestId("memory-mobile-nav-trigger"))

    // The desktop rail is only `display:none` below md, so both copies are
    // mounted — under their OWN prefixes, so each owns its shared-layout pill
    // rather than two elements fighting over one layoutId.
    expect(screen.getByTestId("memory-nav-item-privacy")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("memory-sheet-nav-item-privacy"))
    expect(screen.getByRole("heading", { name: "Privacy" })).toBeInTheDocument()
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

  it("saves the temporary-memory switch from the privacy panel", () => {
    render(<MemorySection />)
    fireEvent.click(screen.getByTestId("memory-nav-item-privacy"))
    fireEvent.click(screen.getByRole("switch", { name: "Temporary mode" }))

    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ memory: expect.objectContaining({ temporary: true }) })
    )
  })

  it("commits both retention limits from the maintenance panel", () => {
    render(<MemorySection />)
    fireEvent.click(screen.getByTestId("memory-nav-item-maintenance"))

    const idle = screen.getByLabelText("Forget after unused days (0 = never)")
    fireEvent.change(idle, { target: { value: "30" } })
    fireEvent.blur(idle)
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ memory: expect.objectContaining({ maxIdleDays: 30 }) })
    )

    // 500 is the resolved default, so a distinct value is needed for the
    // clamped input to consider this an edit worth committing.
    const cap = screen.getByLabelText("Max active memories per scope")
    fireEvent.change(cap, { target: { value: "800" } })
    fireEvent.blur(cap)
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ memory: expect.objectContaining({ maxActivePerScope: 800 }) })
    )
  })

  it("repairs degraded retrieval from the overview panel's own actions", () => {
    render(<MemorySection />)

    // The fixture reports bm25 (hybrid disabled), so the alert offers a fix.
    fireEvent.click(screen.getByRole("button", { name: "Enable hybrid retrieval" }))
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ memory: expect.objectContaining({ hybridEnabled: true }) })
    )
  })

  it("offers the cloud-embedding fix when that is what blocked retrieval", () => {
    mockInsights.retrievalMode = { kind: "bm25", reason: "cloud_blocked", provider: "openai" }
    render(<MemorySection />)

    fireEvent.click(screen.getByRole("button", { name: "Allow cloud embeddings" }))
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ memory: expect.objectContaining({ allowCloudEmbedding: true }) })
    )
    mockInsights.retrievalMode = { kind: "bm25", reason: "hybrid_disabled" }
  })

  it("shows a zero idle limit when retention is unset", () => {
    mockSettings = { memory: { maxIdleDays: 45 } }
    render(<MemorySection />)
    fireEvent.click(screen.getByTestId("memory-nav-item-maintenance"))
    expect(screen.getByLabelText("Forget after unused days (0 = never)")).toHaveValue(45)
  })
})
