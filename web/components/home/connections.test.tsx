import { render, screen, within } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { Connections } from "./connections"

describe("Connections", () => {
  it("renders the heading and the promise", () => {
    render(<Connections copy={en.home.connections} />)
    expect(screen.getByRole("heading", { name: en.home.connections.title })).toBeInTheDocument()
    expect(screen.getByText(en.home.connections.subtitle)).toBeInTheDocument()
  })

  it("shows exactly the four task-level connections", () => {
    render(<Connections copy={en.home.connections} />)
    const items = screen.getAllByRole("listitem")
    expect(items).toHaveLength(4)
  })

  it("answers reads, can act and requires approval for each one", () => {
    render(<Connections copy={en.home.connections} />)
    const items = screen.getAllByRole("listitem")
    en.home.connections.items.forEach((item, index) => {
      const cell = items[index]
      expect(within(cell).getByText(item.name)).toBeInTheDocument()
      expect(within(cell).getByText(item.reads)).toBeInTheDocument()
      expect(within(cell).getByText(item.canAct)).toBeInTheDocument()
      expect(within(cell).getByText(item.requiresApproval)).toBeInTheDocument()
    })
  })

  it("labels each answer with its question", () => {
    render(<Connections copy={en.home.connections} />)
    expect(screen.getAllByText(en.home.connections.headings.reads)).toHaveLength(4)
    expect(screen.getAllByText(en.home.connections.headings.requiresApproval)).toHaveLength(4)
  })

  it("ships no logo ticker", () => {
    const { container } = render(<Connections copy={en.home.connections} />)
    expect(container.querySelectorAll("img")).toHaveLength(0)
  })

  it("defers the full catalogs to the documentation", () => {
    render(<Connections copy={en.home.connections} />)
    expect(screen.getByText(en.home.connections.catalogueNote)).toBeInTheDocument()
  })

  it("localises every receipt", () => {
    render(<Connections copy={zh.home.connections} />)
    for (const item of zh.home.connections.items) {
      expect(screen.getByText(item.name)).toBeInTheDocument()
    }
  })
})
