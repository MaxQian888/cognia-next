import { fireEvent, render, screen, within } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { FaqSection } from "./faq-section"

const DOCS = "https://docs.example.test"

describe("FaqSection", () => {
  it("renders the heading with its index tag and every question", () => {
    const { container } = render(
      <FaqSection copy={en.home.faq} locale="en" docsOrigin={DOCS} index={8} />
    )
    expect(screen.getByRole("heading", { name: en.home.faq.title })).toBeInTheDocument()
    expect(container.querySelector('[data-slot="section-index"]')).toHaveTextContent("08")
    for (const item of en.home.faq.items) {
      expect(screen.getByText(item.question)).toBeInTheDocument()
    }
  })

  it("puts every answer in the server markup, inside a native disclosure", () => {
    // `<details>` keeps the answers readable with no JavaScript and indexable;
    // a JS-only accordion would leave them out of the first paint.
    const { container } = render(<FaqSection copy={en.home.faq} locale="en" docsOrigin={DOCS} />)
    const details = container.querySelectorAll("details")
    expect(details).toHaveLength(en.home.faq.items.length)
    en.home.faq.items.forEach((item, index) => {
      expect(within(details[index] as HTMLElement).getByText(item.answer)).toBeInTheDocument()
      expect(details[index].querySelector("summary")).toHaveTextContent(item.question)
    })
  })

  it("opens one answer at a time", () => {
    const { container } = render(<FaqSection copy={en.home.faq} locale="en" docsOrigin={DOCS} />)
    const details = [...container.querySelectorAll("details")]
    expect(new Set(details.map((d) => d.getAttribute("name")))).toEqual(new Set(["faq"]))
    fireEvent.click(details[0].querySelector("summary") as HTMLElement)
    expect(details[0]).toHaveAttribute("open")
  })

  it("links each answer to where the long version lives", () => {
    render(<FaqSection copy={en.home.faq} locale="en" docsOrigin={DOCS} />)
    const download = screen.getByRole("link", { name: "Open the download page" })
    expect(download).toHaveAttribute("href", "/download")
    const docs = screen.getByRole("link", { name: /Provider documentation/ })
    expect(docs.getAttribute("href")).toBe(`${DOCS}/en/docs/chat/provider-system`)
    expect(screen.getByRole("link", { name: "See every surface" })).toHaveAttribute(
      "href",
      "/surfaces"
    )
  })

  it("carries the faq anchor the footer links to", () => {
    const { container } = render(<FaqSection copy={en.home.faq} locale="en" docsOrigin={DOCS} />)
    expect(container.querySelector("section#faq")).toBeInTheDocument()
  })

  it("localises", () => {
    render(<FaqSection copy={zh.home.faq} locale="zh" docsOrigin={DOCS} />)
    expect(screen.getByRole("heading", { name: zh.home.faq.title })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "打开下载页" })).toHaveAttribute("href", "/zh/download")
  })
})
