import { render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { PageClose } from "./page-close"

const DOCS = "https://docs.cognia.example"

describe("PageClose", () => {
  it("closes on one heading with the build and source actions", () => {
    render(<PageClose locale="en" docsOrigin={DOCS} />)
    expect(
      screen.getByRole("heading", { level: 2, name: en.common.pageClose.title })
    ).toBeInTheDocument()
    expect(screen.getByText(en.common.pageClose.body)).toBeInTheDocument()
    // The same pair the homepage opens and closes with, release state included.
    expect(screen.getByRole("link", { name: en.common.viewSource })).toBeInTheDocument()
  })

  it("points at the documentation as the quieter follow-up", () => {
    render(<PageClose locale="en" docsOrigin={DOCS} />)
    expect(screen.getByRole("link", { name: en.common.readDocs })).toHaveAttribute(
      "href",
      `${DOCS}/en/docs`
    )
  })

  it("sits on the execution stage, like the homepage's close", () => {
    const { container } = render(<PageClose locale="en" docsOrigin={DOCS} />)
    const section = container.querySelector("section")
    expect(section).toHaveClass("bg-stage", "stage-scope")
  })

  it("localises the close", () => {
    render(<PageClose locale="zh" docsOrigin={DOCS} />)
    expect(
      screen.getByRole("heading", { level: 2, name: zh.common.pageClose.title })
    ).toBeInTheDocument()
    expect(screen.getByRole("link", { name: zh.common.readDocs })).toHaveAttribute(
      "href",
      `${DOCS}/zh/docs`
    )
  })
})
