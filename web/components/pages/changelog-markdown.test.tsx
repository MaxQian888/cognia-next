import { render, screen } from "@testing-library/react"
import { parseBlocks } from "@web/lib/markdown-inline"
import { ChangelogMarkdown } from "./changelog-markdown"

describe("ChangelogMarkdown", () => {
  it("renders strong, emphasis and code as elements rather than literal markers", () => {
    const { container } = render(
      <ChangelogMarkdown blocks={parseBlocks("A **bold** and _quiet_ `fix`.")} />
    )
    expect(container.querySelector("strong")).toHaveTextContent("bold")
    expect(container.querySelector("em")).toHaveTextContent("quiet")
    expect(container.querySelector("code")).toHaveTextContent("fix")
    expect(container.textContent).not.toContain("**")
    expect(container.textContent).not.toContain("_quiet_")
  })

  it("renders bullet lists as lists", () => {
    render(<ChangelogMarkdown blocks={parseBlocks("Intro\n- one\n- two")} />)
    expect(screen.getAllByRole("listitem")).toHaveLength(2)
    expect(screen.getByText("Intro")).toBeInTheDocument()
  })

  it("never turns author text into markup", () => {
    const { container } = render(
      <ChangelogMarkdown blocks={parseBlocks("keeps <details> and <script> as words")} />
    )
    expect(container.querySelector("details")).toBeNull()
    expect(container.querySelector("script")).toBeNull()
    expect(container.textContent).toContain("<details>")
  })

  it("renders nothing for an empty body", () => {
    const { container } = render(<ChangelogMarkdown blocks={[]} />)
    expect(container.querySelectorAll("p, ul")).toHaveLength(0)
  })
})
