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

  it("hides the decorative path line from assistive technology", () => {
    const { container } = render(
      <WorkbenchBento
        copy={en.home.workbench}
        common={en.common}
        reconstruction={en.reconstruction}
      />
    )
    // The path is now drawn by `Hairline`, which is `aria-hidden` in both the
    // animated and the reduced-motion branch. The meaning it carries lives in
    // the borders, the copy and the one screen-reader sentence beside it.
    const line = container.querySelector('[aria-hidden="true"].bg-action')
    expect(line).toBeInTheDocument()
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
