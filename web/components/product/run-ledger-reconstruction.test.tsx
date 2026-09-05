import { act, render, screen } from "@testing-library/react"

let inView = false
jest.mock("motion/react", () => ({
  useReducedMotion: () => false,
  useInView: () => inView,
}))
import { DEMO_TASK } from "@web/content/demo-task"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import {
  LEDGER_PHASE_DELAYS,
  RunLedgerReconstruction,
  ledgerState,
} from "./run-ledger-reconstruction"

describe("RunLedgerReconstruction", () => {
  it("carries the reconstruction marker", () => {
    render(<RunLedgerReconstruction copy={en.reconstruction} />)
    expect(screen.getByText(en.reconstruction.label)).toBeInTheDocument()
  })

  it("lists one row per plan step with its tool and its state in words", () => {
    render(<RunLedgerReconstruction copy={en.reconstruction} />)
    for (const step of DEMO_TASK.plan) {
      const item = en.reconstruction.artifacts.plan.items[step.key]
      expect(screen.getByText(item.text)).toBeInTheDocument()
    }
    const labels = en.reconstruction.artifacts.plan.stateLabels
    const states = DEMO_TASK.plan.map(
      (step) => labels[en.reconstruction.artifacts.plan.items[step.key].state]
    )
    for (const state of new Set(states)) {
      expect(screen.getAllByText(state).length).toBe(states.filter((s) => s === state).length)
    }
  })

  it("names its three columns", () => {
    render(<RunLedgerReconstruction copy={en.reconstruction} />)
    const headings = en.reconstruction.workflow.runHeadings
    for (const heading of [headings.step, headings.tool, headings.state]) {
      expect(screen.getByText(heading)).toBeInTheDocument()
    }
  })

  it("localises", () => {
    render(<RunLedgerReconstruction copy={zh.reconstruction} />)
    expect(screen.getAllByText(zh.reconstruction.workflow.runsLabel).length).toBeGreaterThan(0)
    expect(screen.getByText(zh.reconstruction.workflow.runHeadings.state)).toBeInTheDocument()
  })
})

describe("ledgerState", () => {
  beforeEach(() => {
    inView = false
    jest.useFakeTimers()
  })
  afterEach(() => jest.useRealTimers())

  it("advances one step per phase and ends on the fixture's own state", () => {
    expect(ledgerState(0, 0, "done")).toBe("active")
    expect(ledgerState(1, 0, "done")).toBe("todo")
    expect(ledgerState(0, 2, "done")).toBe("done")
    expect(ledgerState(2, 2, "active")).toBe("active")
    expect(ledgerState(3, LEDGER_PHASE_DELAYS.length, "todo")).toBe("todo")
    expect(ledgerState(0, LEDGER_PHASE_DELAYS.length, "done")).toBe("done")
  })

  it("waits at the first step while live but off screen", () => {
    const { container } = render(<RunLedgerReconstruction copy={en.reconstruction} live />)
    const states = [...container.querySelectorAll("[data-row-state]")].map((node) =>
      node.getAttribute("data-row-state")
    )
    expect(states).toEqual(["active", "todo", "todo", "todo"])
  })

  it("plays the run row by row once on screen and ends on the fixture", () => {
    inView = true
    const { container } = render(<RunLedgerReconstruction copy={en.reconstruction} live />)
    const states = () =>
      [...container.querySelectorAll("[data-row-state]")].map((node) =>
        node.getAttribute("data-row-state")
      )
    expect(states()).toEqual(["active", "todo", "todo", "todo"])
    act(() => {
      jest.advanceTimersByTime(LEDGER_PHASE_DELAYS[0])
    })
    expect(states()).toEqual(["done", "active", "todo", "todo"])
    act(() => {
      jest.advanceTimersByTime(10_000)
    })
    expect(states()).toEqual(
      DEMO_TASK.plan.map((step) => en.reconstruction.artifacts.plan.items[step.key].state)
    )
  })
})
