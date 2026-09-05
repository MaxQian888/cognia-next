import { render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { WorkbenchBento } from "./workbench-bento"

describe("WorkbenchBento", () => {
  it("renders the section heading and its argument", () => {
    render(
      <WorkbenchBento
        copy={en.home.workbench}
        common={en.common}
        reconstruction={en.reconstruction}
      />
    )
    expect(screen.getByRole("heading", { name: en.home.workbench.title })).toBeInTheDocument()
    expect(screen.getByText(en.home.workbench.subtitle)).toBeInTheDocument()
  })

  it("shows all six panels", () => {
    render(
      <WorkbenchBento
        copy={en.home.workbench}
        common={en.common}
        reconstruction={en.reconstruction}
      />
    )
    for (const panel of en.home.workbench.panels) {
      expect(screen.getByText(panel.label)).toBeInTheDocument()
      expect(screen.getByText(panel.body)).toBeInTheDocument()
    }
  })

  it("describes the context path in words rather than only drawing it", () => {
    render(
      <WorkbenchBento
        copy={en.home.workbench}
        common={en.common}
        reconstruction={en.reconstruction}
      />
    )
    expect(screen.getByText(en.common.contextPathLabel)).toBeInTheDocument()
  })

  it("lights the six stations in the order the task reaches them, and hides the marks", () => {
    const { container } = render(
      <WorkbenchBento
        copy={en.home.workbench}
        common={en.common}
        reconstruction={en.reconstruction}
      />
    )
    const cells = [...container.querySelectorAll(".station-lit")] as HTMLElement[]
    expect(cells).toHaveLength(en.home.workbench.panels.length)
    const delays = cells.map((cell) => parseInt(cell.style.getPropertyValue("--station-delay"), 10))
    expect(delays).toEqual([...delays].sort((a, b) => a - b))
    expect(new Set(delays).size).toBe(delays.length)
    // Every station dot is decoration. The meaning lives in the borders, the
    // copy and the one screen-reader sentence beside them.
    for (const dot of container.querySelectorAll(".bg-action")) {
      expect(dot).toHaveAttribute("aria-hidden")
    }
  })

  it("no longer draws a rule across the middle of the grid", () => {
    const { container } = render(
      <WorkbenchBento
        copy={en.home.workbench}
        common={en.common}
        reconstruction={en.reconstruction}
      />
    )
    expect(container.querySelector(".top-1\\/2")).toBeNull()
  })

  it("uses shared hairlines so the panels read as one surface, not five cards", () => {
    const { container } = render(
      <WorkbenchBento
        copy={en.home.workbench}
        common={en.common}
        reconstruction={en.reconstruction}
      />
    )
    expect(container.querySelector(".gap-px.bg-hairline")).toBeInTheDocument()
    expect(container.querySelector('[data-slot="bento-grid"]')).toBeInTheDocument()
    expect(container.querySelector(".rounded-stage")).toBeNull()
  })

  it("localises every panel", () => {
    render(
      <WorkbenchBento
        copy={zh.home.workbench}
        common={zh.common}
        reconstruction={zh.reconstruction}
      />
    )
    for (const panel of zh.home.workbench.panels) {
      expect(screen.getByText(panel.label)).toBeInTheDocument()
    }
  })
})
