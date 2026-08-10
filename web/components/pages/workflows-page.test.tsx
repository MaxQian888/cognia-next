import { render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { WorkflowsPage } from "./workflows-page"

jest.mock("next-themes", () => ({ useTheme: () => ({ theme: "system", setTheme: jest.fn() }) }))

describe("WorkflowsPage", () => {
  it("carries the page heading and both sections", () => {
    render(<WorkflowsPage locale="en" />)
    expect(
      screen.getByRole("heading", { level: 1, name: en.workflows.header.title })
    ).toBeInTheDocument()
    for (const section of en.workflows.sections) {
      expect(screen.getByRole("heading", { name: section.title })).toBeInTheDocument()
    }
  })

  it("states what the runner guarantees, not what it can do", () => {
    render(<WorkflowsPage locale="en" />)
    expect(screen.getByRole("heading", { name: en.workflows.guarantees.title })).toBeInTheDocument()
    for (const item of en.workflows.guarantees.items) {
      expect(screen.getByText(item, { exact: false })).toBeInTheDocument()
    }
  })

  it("shows the full path from trigger to recorded run", () => {
    render(<WorkflowsPage locale="en" />)
    expect(screen.getByRole("heading", { name: "From event to evidence." })).toBeInTheDocument()
    for (const title of ["Trigger", "Typed graph", "Controlled execution", "Run record"]) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument()
    }
  })

  it("puts the guarantees on the dark execution stage", () => {
    const { container } = render(<WorkflowsPage locale="en" />)
    const sections = [...container.querySelectorAll("section")]
    expect(sections.at(-1)).toHaveClass("bg-stage")
  })

  it("routes the language switcher to the Chinese workflows page", () => {
    render(<WorkflowsPage locale="en" />)
    expect(screen.getAllByRole("link", { name: "中文" })[0]).toHaveAttribute(
      "href",
      "/zh/workflows"
    )
  })

  it("localises", () => {
    render(<WorkflowsPage locale="zh" />)
    expect(screen.getByRole("heading", { name: zh.workflows.guarantees.title })).toBeInTheDocument()
  })
})
