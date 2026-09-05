import { act, render, screen } from "@testing-library/react"

let reduced = false
let inView = false
jest.mock("motion/react", () => ({
  useReducedMotion: () => reduced,
  useInView: () => inView,
}))
import { DEMO_TASK } from "@web/content/demo-task"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import {
  GRAPH_PHASE_DELAYS,
  GRAPH_REJECT_PHASE,
  WorkflowGraphReconstruction,
} from "./workflow-graph-reconstruction"

describe("WorkflowGraphReconstruction", () => {
  it("carries the reconstruction marker", () => {
    render(<WorkflowGraphReconstruction copy={en.reconstruction} />)
    expect(screen.getByText(en.reconstruction.label)).toBeInTheDocument()
  })

  it("draws the signature task's plan as the graph's nodes, in order", () => {
    render(<WorkflowGraphReconstruction copy={en.reconstruction} />)
    const items = screen.getAllByRole("listitem").map((li) => li.textContent ?? "")
    expect(items).toHaveLength(DEMO_TASK.plan.length + 1)
    expect(items[0]).toContain(en.reconstruction.workflow.triggerName)
    DEMO_TASK.plan.forEach((step, index) => {
      expect(items[index + 1]).toContain(en.reconstruction.artifacts.plan.items[step.key].text)
      expect(items[index + 1]).toContain(step.tool)
    })
  })

  it("keeps its marks out of the accessibility tree", () => {
    const { container } = render(<WorkflowGraphReconstruction copy={en.reconstruction} />)
    for (const svg of container.querySelectorAll("svg")) {
      expect(svg).toHaveAttribute("aria-hidden", "true")
    }
  })

  it("localises", () => {
    render(<WorkflowGraphReconstruction copy={zh.reconstruction} />)
    expect(screen.getByText(zh.reconstruction.workflow.triggerName)).toBeInTheDocument()
    expect(screen.getAllByText(zh.reconstruction.workflow.graphLabel).length).toBeGreaterThan(0)
  })
})

describe("WorkflowGraphReconstruction live", () => {
  beforeEach(() => {
    reduced = false
    inView = false
    jest.useFakeTimers()
  })
  afterEach(() => jest.useRealTimers())

  it("waits at the opening state while off screen, and finishes under reduced motion", () => {
    const { container, unmount } = render(
      <WorkflowGraphReconstruction copy={en.reconstruction} live />
    )
    expect(container.querySelector('[data-slot="workflow-graph"]')).toHaveAttribute(
      "data-phase",
      "0"
    )
    expect(container.querySelectorAll("[data-landed]")).toHaveLength(0)
    unmount()

    reduced = true
    const still = render(<WorkflowGraphReconstruction copy={en.reconstruction} live />).container
    expect(still.querySelectorAll("[data-landed]")).toHaveLength(DEMO_TASK.plan.length)
    expect(still.querySelector('[data-slot="back-edge"]')).toHaveAttribute("data-rejected", "true")
    expect(screen.getByText(en.reconstruction.workflow.cycleRejectedLabel)).toBeInTheDocument()
  })

  it("lands one node per phase once on screen, then draws and refuses the back-edge", () => {
    inView = true
    const { container } = render(<WorkflowGraphReconstruction copy={en.reconstruction} live />)
    expect(container.querySelectorAll("[data-landed]")).toHaveLength(0)
    expect(container.querySelector('[data-slot="back-edge"]')).not.toHaveAttribute("data-rejected")
    act(() => {
      jest.advanceTimersByTime(GRAPH_PHASE_DELAYS[0] + GRAPH_PHASE_DELAYS[1])
    })
    expect(container.querySelectorAll("[data-landed]")).toHaveLength(2)
    act(() => {
      jest.advanceTimersByTime(10_000)
    })
    expect(container.querySelectorAll("[data-landed]")).toHaveLength(DEMO_TASK.plan.length)
    expect(container.querySelector('[data-slot="back-edge"]')).toHaveAttribute(
      "data-rejected",
      "true"
    )
  })

  it("shows the same finished graph when not live", () => {
    inView = true
    const { container } = render(<WorkflowGraphReconstruction copy={en.reconstruction} />)
    expect(container.querySelectorAll("[data-landed]")).toHaveLength(DEMO_TASK.plan.length)
    expect(GRAPH_PHASE_DELAYS).toHaveLength(DEMO_TASK.plan.length + 1)
  })
})
