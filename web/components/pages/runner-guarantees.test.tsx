import { act, render, screen, within } from "@testing-library/react"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"

let reduced = false
let inView = true
jest.mock("motion/react", () => ({
  useReducedMotion: () => reduced,
  useInView: () => inView,
}))

import { GUARANTEE_STEP_MS, RunnerGuarantees, SUBWORKFLOW_DEPTH_LIMIT } from "./runner-guarantees"

describe("RunnerGuarantees", () => {
  beforeEach(() => {
    reduced = false
    inView = true
    jest.useFakeTimers()
  })
  afterEach(() => jest.useRealTimers())

  it("keeps every guarantee sentence as content, with one demonstration beside each", () => {
    const { container } = render(<RunnerGuarantees copy={en.workflows.guarantees} />)
    expect(screen.getByRole("heading", { name: en.workflows.guarantees.title })).toBeInTheDocument()
    for (const item of en.workflows.guarantees.items) {
      expect(screen.getByText(item)).toBeInTheDocument()
    }
    expect(
      [...container.querySelectorAll("[data-demo]")].map((node) => node.getAttribute("data-demo"))
    ).toEqual(["triggers", "cycle", "depth", "states"])
    for (const demo of container.querySelectorAll("[data-demo]")) {
      expect(demo.closest("[aria-hidden]")).not.toBeNull()
    }
  })

  it("plays all four demonstrations from one clock and stops on the finished picture", () => {
    const { container } = render(<RunnerGuarantees copy={en.workflows.guarantees} />)
    const root = container.querySelector('[data-slot="guarantees"]') as HTMLElement
    expect(root).toHaveAttribute("data-beat", "0")
    expect(container.querySelector('[data-demo="cycle"]')).not.toHaveAttribute("data-rejected")
    expect(container.querySelectorAll('[data-demo="states"] [data-state="pending"]')).toHaveLength(
      4
    )

    act(() => {
      jest.advanceTimersByTime(GUARANTEE_STEP_MS * 3)
    })
    expect(root).toHaveAttribute("data-beat", "3")
    expect(container.querySelector('[data-demo="cycle"]')).toHaveAttribute("data-rejected", "true")
    expect(container.querySelector('[data-demo="depth"]')).toHaveAttribute("data-level", "3")

    act(() => {
      jest.advanceTimersByTime(GUARANTEE_STEP_MS * 20)
    })
    expect(container.querySelector('[data-demo="depth"]')).toHaveAttribute(
      "data-level",
      String(SUBWORKFLOW_DEPTH_LIMIT)
    )
    const states = [...container.querySelectorAll('[data-demo="states"] [data-state]')].map(
      (node) => node.getAttribute("data-state")
    )
    expect(states).toEqual(en.workflows.guarantees.demos.states.items.map((item) => item.state))
    expect(states).toContain("skipped")
  })

  it("renders the finished picture at once under reduced motion", () => {
    reduced = true
    const { container } = render(<RunnerGuarantees copy={en.workflows.guarantees} />)
    expect(container.querySelector('[data-slot="guarantees"]')).not.toHaveAttribute("data-live")
    expect(container.querySelector('[data-demo="cycle"]')).toHaveAttribute("data-rejected", "true")
    expect(container.querySelector('[data-demo="depth"]')).toHaveAttribute(
      "data-level",
      String(SUBWORKFLOW_DEPTH_LIMIT)
    )
    expect(screen.getByText(en.workflows.guarantees.demos.cycle.rejectedLabel)).toBeInTheDocument()
  })

  it("highlights one trigger at a time and always the same runner", () => {
    const { container } = render(<RunnerGuarantees copy={en.workflows.guarantees} />)
    const triggers = container.querySelector('[data-demo="triggers"]') as HTMLElement
    expect(
      within(triggers).getByText(en.workflows.guarantees.demos.runnerLabel)
    ).toBeInTheDocument()
    expect(triggers.querySelectorAll("[data-active]")).toHaveLength(1)
    act(() => {
      jest.advanceTimersByTime(GUARANTEE_STEP_MS)
    })
    expect(triggers.querySelectorAll("[data-active]")).toHaveLength(1)
    expect(triggers.querySelector("[data-active]")).toHaveTextContent(
      en.workflows.guarantees.demos.triggers[1]
    )
  })

  it("quotes the nesting limit the runtime enforces", () => {
    const source = readFileSync(
      join(__dirname, "../../../lib/workflow/nodes/shared/executor-support.ts"),
      "utf8"
    )
    expect(source).toContain(`MAX_SUBWORKFLOW_DEPTH = ${SUBWORKFLOW_DEPTH_LIMIT}`)
  })

  it("renders the Chinese copy with the same four demonstrations", () => {
    const { container } = render(<RunnerGuarantees copy={zh.workflows.guarantees} />)
    expect(screen.getByRole("heading", { name: zh.workflows.guarantees.title })).toBeInTheDocument()
    expect(container.querySelectorAll("[data-demo]")).toHaveLength(4)
    expect(zh.workflows.guarantees.demos.triggers).toHaveLength(
      en.workflows.guarantees.demos.triggers.length
    )
  })
})
