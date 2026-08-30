/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

import type { MemoryInsights } from "@/hooks/memory/use-memory-insights"
import { DEFAULT_MEMORY_CONFIG } from "@/types/memory/memory"
import { ProjectContextPanel } from "./project-context-panel"

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: true, durationScale: 1 }),
}))

const insights: MemoryInsights = {
  corpus: {
    stats: {
      total: 0,
      active: 0,
      pinned: 0,
      conflicts: 0,
      byType: { semantic: 0, episodic: 0, procedural: 0 },
    },
    byScope: { global: 0, workspace: 0, character: 0, agent: 0 },
    vector: { embedded: 0, active: 0, coverage: 0 },
    averageTokens: 0,
  },
  jobs: [],
  maintenance: undefined,
  maintenanceWindowStart: 0,
  retrievalMode: { kind: "bm25", reason: "hybrid_disabled" },
  loading: false,
  refreshRetrievalMode: jest.fn(),
}

function setup(over: Partial<Parameters<typeof ProjectContextPanel>[0]> = {}) {
  const update = jest.fn()
  render(
    <ProjectContextPanel
      config={DEFAULT_MEMORY_CONFIG}
      update={update}
      insights={insights}
      {...over}
    />
  )
  return { update }
}

describe("ProjectContextPanel", () => {
  it("renders the shipped defaults: mining on, injection off", () => {
    // The whole reason this panel exists. Until it shipped, mining was on with
    // no switch anywhere in the product to turn it off.
    setup()
    expect(screen.getByLabelText(/Learn from this workspace/)).toBeChecked()
    expect(screen.getByLabelText(/Tell the model what was learned/)).not.toBeChecked()
  })

  it("writes each switch through the shared config patch", () => {
    const { update } = setup()
    fireEvent.click(screen.getByLabelText(/Learn from this workspace/))
    expect(update).toHaveBeenCalledWith({ mineProjectContext: false })
    fireEvent.click(screen.getByLabelText(/Tell the model what was learned/))
    expect(update).toHaveBeenCalledWith({ enableProjectContinuity: true })
  })

  it("keeps the budget controls inert until injection is on", () => {
    // A token budget for a section that is never rendered is a control with no
    // effect, which is this repo's recurring "setting that lied" shape.
    const { container } = { container: document.body }
    setup()
    const gatedGroups = container.querySelectorAll('[data-gated="true"]')
    expect(gatedGroups.length).toBeGreaterThan(0)
    expect(screen.getByText(/only take effect once project context is injected/)).toBeTruthy()
  })

  it("frees the budget controls once injection is on", () => {
    setup({
      config: { ...DEFAULT_MEMORY_CONFIG, enableProjectContinuity: true },
    })
    expect(screen.queryByText(/only take effect once project context is injected/)).toBeNull()
    expect(screen.getByLabelText(/Project context budget/)).toBeTruthy()
  })

  it("states the honest combined ceiling, not the sum of the two maxima", () => {
    // Every borrowed token is one personal recall did not spend, so the bound is
    // `recallTokenBudget + projectRecallTokenBudget`, which is 1350 at defaults.
    setup({ config: { ...DEFAULT_MEMORY_CONFIG, enableProjectContinuity: true } })
    expect(screen.getByText(/1350 tokens in total/)).toBeTruthy()
  })

  it("names the upstream switch that turned everything off", () => {
    setup({ config: { ...DEFAULT_MEMORY_CONFIG, enabled: false } })
    expect(screen.getByText(/Long-term memory is off/)).toBeTruthy()
  })

  it("distinguishes temporary mode from memory being off", () => {
    setup({ config: { ...DEFAULT_MEMORY_CONFIG, temporary: true } })
    expect(screen.getByText(/Temporary mode leaves no trace/)).toBeTruthy()
  })

  it("reports an idle queue rather than hiding the section", () => {
    // "Nothing is queued" is the answer to "is it working?", and a section that
    // appears only when busy cannot give it.
    setup()
    expect(screen.getByText("Nothing queued")).toBeTruthy()
  })

  it("counts only this feature's job kinds", () => {
    setup({
      insights: {
        ...insights,
        jobs: [
          { kind: "project-mining", queued: 2, running: 1, retrying: 0, failed: 1 },
          { kind: "turn-extraction", queued: 9, running: 9, retrying: 9, failed: 9 },
        ],
      },
    })
    expect(screen.getByText(/3 jobs queued or running/)).toBeTruthy()
    expect(screen.getByText(/1 gave up after retries/)).toBeTruthy()
  })
})
