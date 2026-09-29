/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from "@/types/memory/memory"
import type { MemoryInsights } from "@/hooks/memory/use-memory-insights"
import { MaintenancePanel } from "./maintenance-panel"

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: true, durationScale: 1 }),
}))

const BM25: Pick<MemoryInsights, "retrievalMode"> = {
  retrievalMode: { kind: "bm25", reason: "hybrid_disabled" },
}
const HYBRID = {
  retrievalMode: { kind: "hybrid" },
} as unknown as Pick<MemoryInsights, "retrievalMode">

function setup(
  config: Partial<MemoryConfig> = {},
  insights: Pick<MemoryInsights, "retrievalMode"> = BM25
) {
  const update = jest.fn()
  render(
    <MaintenancePanel
      config={{ ...DEFAULT_MEMORY_CONFIG, ...config }}
      update={update}
      insights={insights}
    />
  )
  return { update }
}

describe("MaintenancePanel — forgetting", () => {
  it("commits the idle expiry and the per-scope cap", () => {
    const { update } = setup({ maxIdleDays: 0, maxActivePerScope: 500 })

    const idle = screen.getByLabelText("Forget after unused days (0 = never)")
    fireEvent.change(idle, { target: { value: "30" } })
    fireEvent.blur(idle)
    expect(update).toHaveBeenCalledWith({ maxIdleDays: 30 })

    const cap = screen.getByLabelText("Max active memories per scope")
    fireEvent.change(cap, { target: { value: "800" } })
    fireEvent.blur(cap)
    expect(update).toHaveBeenCalledWith({ maxActivePerScope: 800 })
  })

  it("shows zero idle days when the expiry is unset", () => {
    setup({ maxIdleDays: undefined })
    expect(screen.getByLabelText("Forget after unused days (0 = never)")).toHaveValue(0)
  })

  it("defaults access reinforcement to 0.6 and reads Off at zero", () => {
    const { unmount } = render(
      <MaintenancePanel
        config={{ ...DEFAULT_MEMORY_CONFIG, accessReinforcementWeight: undefined }}
        update={jest.fn()}
        insights={BM25}
      />
    )
    expect(screen.getByTestId("mem-access-reinforcement-value")).toHaveTextContent("0.6")
    unmount()

    setup({ accessReinforcementWeight: 0 })
    expect(screen.getByTestId("mem-access-reinforcement-value")).toHaveTextContent("Off")
  })

  it("steps access reinforcement by 0.1 and rounds away float noise", () => {
    const { update } = setup({ accessReinforcementWeight: 0.6 })
    fireEvent.keyDown(screen.getByRole("slider", { name: "Access reinforcement" }), {
      key: "ArrowRight",
    })
    expect(update).toHaveBeenCalledWith({ accessReinforcementWeight: 0.7 })
  })
})

describe("MaintenancePanel — lifecycle sweep", () => {
  it("toggles compaction and duplicate folding", () => {
    const { update } = setup({ compactColdEpisodic: false, dedupColdClusters: false })
    fireEvent.click(screen.getByRole("switch", { name: "Compact cold episodes" }))
    fireEvent.click(screen.getByRole("switch", { name: "Fold near-duplicate episodes" }))
    expect(update).toHaveBeenCalledWith({ compactColdEpisodic: true })
    expect(update).toHaveBeenCalledWith({ dedupColdClusters: true })
  })

  it("disables both passes while memory is off", () => {
    setup({ enabled: false })
    expect(screen.getByRole("switch", { name: "Compact cold episodes" })).toBeDisabled()
    expect(screen.getByRole("switch", { name: "Fold near-duplicate episodes" })).toBeDisabled()
  })

  it("warns that folding will not run without stored vectors", () => {
    setup({ dedupColdClusters: true }, BM25)
    expect(screen.getByTestId("mem-dedup-no-vectors")).toHaveTextContent(
      "Needs hybrid retrieval with an allowed embedding backend"
    )
  })

  it("does not warn when hybrid retrieval is available", () => {
    setup({ dedupColdClusters: true }, HYBRID)
    expect(screen.queryByTestId("mem-dedup-no-vectors")).toBeNull()
  })

  it("does not warn while folding is off", () => {
    setup({ dedupColdClusters: false }, BM25)
    expect(screen.queryByTestId("mem-dedup-no-vectors")).toBeNull()
  })

  it("gates the cold threshold (inert, not hidden) while neither pass is on", () => {
    setup({ compactColdEpisodic: false, dedupColdClusters: false })
    expect(screen.getByTestId("memory-gate-reason")).toHaveTextContent(
      "Turn on compaction or duplicate folding to use the sweep."
    )
    expect(
      screen.getByRole("slider", { name: "Cold threshold", hidden: true }).closest("[inert]")
    ).not.toBeNull()
  })

  it.each([
    ["compaction", { compactColdEpisodic: true, dedupColdClusters: false }],
    ["folding", { compactColdEpisodic: false, dedupColdClusters: true }],
  ])("ungates the cold threshold when %s is on", (_label, config) => {
    setup(config, HYBRID)
    expect(screen.queryByTestId("memory-gate-reason")).toBeNull()
    expect(screen.getByRole("slider", { name: "Cold threshold" }).closest("[inert]")).toBeNull()
  })

  it("defaults the cold threshold to 0.20 and commits a rounded step", () => {
    const { update } = setup({ compactColdEpisodic: true, coldRetentionThreshold: undefined })
    expect(screen.getByTestId("mem-cold-threshold-value")).toHaveTextContent("0.20")
    fireEvent.keyDown(screen.getByRole("slider", { name: "Cold threshold" }), { key: "ArrowRight" })
    expect(update).toHaveBeenCalledWith({ coldRetentionThreshold: 0.25 })
  })
})
