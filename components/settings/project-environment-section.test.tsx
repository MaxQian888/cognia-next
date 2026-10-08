import { render, screen } from "@testing-library/react"

import {
  ProjectEnvironmentSection,
  projectEnvironmentSectionId,
} from "./project-environment-section"

describe("ProjectEnvironmentSection", () => {
  it("is a frameless chapter with a heading and a stable anchor", () => {
    render(
      <ProjectEnvironmentSection id="variables" title="Variables" meta="2">
        <p>body</p>
      </ProjectEnvironmentSection>
    )
    const section = screen.getByTestId(projectEnvironmentSectionId("variables"))
    expect(section).toHaveAttribute("id", "project-environment-section-variables")
    expect(section).toHaveAttribute("data-variant", "sheet")
    expect(section).not.toHaveAttribute("data-surface-layer")
    expect(screen.getByRole("heading", { name: "Variables" })).toBeInTheDocument()
    expect(screen.getByText("2")).toBeInTheDocument()
  })

  /**
   * Inner grids size off the editor's own width, so the section has to name
   * the environment pane: a sheet and a full page give it very different
   * widths on the same monitor.
   */
  it("spans and sizes against the environment pane", () => {
    render(
      <ProjectEnvironmentSection id="runtime" title="Runtime" wide>
        <p>body</p>
      </ProjectEnvironmentSection>
    )
    const section = screen.getByTestId(projectEnvironmentSectionId("runtime"))
    expect(section.className).toContain("@3xl/environment-pane:col-span-2")
    expect(screen.getByText("body").parentElement?.className).toContain(
      "@container/environment-card"
    )
  })
})
