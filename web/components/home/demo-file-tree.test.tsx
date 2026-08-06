/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { en } from "@web/content/en"

import { DemoFileTree } from "./demo-file-tree"

describe("DemoFileTree", () => {
  const props = {
    ariaLabel: "Repository file tree",
    copy: en.reconstruction.artifacts.context,
  }

  it("renders the repository name", () => {
    render(<DemoFileTree {...props} />)
    expect(screen.getByText("acme/checkout-service")).toBeInTheDocument()
  })

  it("renders file names from DEMO_TASK", () => {
    render(<DemoFileTree {...props} />)
    expect(screen.getByText("total.ts")).toBeInTheDocument()
    expect(screen.getByText("total.test.ts")).toBeInTheDocument()
    expect(screen.getByText("AGENTS.md")).toBeInTheDocument()
  })

  it("has an accessible region label", () => {
    render(<DemoFileTree {...props} />)
    expect(screen.getByRole("region", { name: "Repository file tree" })).toBeInTheDocument()
  })

  it("renders folder structure", () => {
    render(<DemoFileTree {...props} />)
    expect(screen.getByText("src")).toBeInTheDocument()
    expect(screen.getByText("checkout")).toBeInTheDocument()
  })

  it("updates the adjacent file detail when a file is selected", () => {
    render(<DemoFileTree {...props} />)

    expect(screen.getByText("src/checkout/total.ts")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /total\.test\.ts/i }))

    expect(screen.getByText("src/checkout/total.test.ts")).toBeInTheDocument()
    expect(screen.getByText(en.reconstruction.artifacts.context.fileNotes.test)).toBeInTheDocument()
  })
})
