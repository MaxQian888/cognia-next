import { fireEvent, render, screen, within } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { Connections } from "./connections"

describe("Connections", () => {
  it("renders the heading and the promise", () => {
    render(<Connections copy={en.plugins.connections} />)
    expect(screen.getByRole("heading", { name: en.plugins.connections.title })).toBeInTheDocument()
    expect(screen.getByText(en.plugins.connections.subtitle)).toBeInTheDocument()
  })

  it("shows exactly the four task-level connections", () => {
    render(<Connections copy={en.plugins.connections} />)
    const lists = screen.getAllByRole("list")
    expect(within(lists[0]).getAllByRole("listitem")).toHaveLength(4)
  })

  it("answers reads, can act and requires approval for each one", () => {
    render(<Connections copy={en.plugins.connections} />)
    const items = within(screen.getAllByRole("list")[0]).getAllByRole("listitem")
    en.plugins.connections.items.forEach((item, index) => {
      const cell = items[index]
      expect(within(cell).getByText(item.name)).toBeInTheDocument()
      expect(within(cell).getByText(item.reads)).toBeInTheDocument()
      expect(within(cell).getByText(item.canAct)).toBeInTheDocument()
      expect(within(cell).getByText(item.requiresApproval)).toBeInTheDocument()
    })
  })

  it("labels each answer with its question", () => {
    render(<Connections copy={en.plugins.connections} />)
    expect(screen.getAllByText(en.plugins.connections.headings.reads)).toHaveLength(4)
    expect(screen.getAllByText(en.plugins.connections.headings.requiresApproval)).toHaveLength(4)
  })

  it("ships no logo ticker", () => {
    const { container } = render(<Connections copy={en.plugins.connections} />)
    expect(container.querySelectorAll("img")).toHaveLength(0)
  })

  it("no longer carries the agent interop index, which moved to the run strategies", () => {
    const { container } = render(<Connections copy={en.plugins.connections} />)
    expect(container.querySelector('[data-slot="agent-interop"]')).toBeNull()
  })

  it("defers the full catalogs to the documentation", () => {
    render(<Connections copy={en.plugins.connections} />)
    expect(screen.getByText(en.plugins.connections.catalogueNote)).toBeInTheDocument()
  })

  it("highlights the matching receipt when a flow source receives focus", () => {
    render(<Connections copy={en.plugins.connections} flowCopy={en.plugins.connectionFlow} />)
    const flow = screen.getByRole("group", { name: en.plugins.connectionFlow.label })
    const source = within(flow).getByRole("button", { name: en.plugins.connections.items[0].name })
    fireEvent.focus(source)

    const receipt = within(screen.getAllByRole("list")[0]).getAllByRole("listitem")[0]
    expect(receipt).toHaveAttribute("data-active", "true")
    expect(screen.getAllByRole("list")[0]).toHaveStyle({
      "--receipt-columns": "1.35fr 1fr 1fr 1fr",
    })

    fireEvent.blur(source)
    expect(screen.getAllByRole("list")[0]).toHaveStyle({
      "--receipt-columns": "1fr 1fr 1fr 1fr",
    })
  })

  it("localises every receipt", () => {
    render(<Connections copy={zh.plugins.connections} />)
    for (const item of zh.plugins.connections.items) {
      expect(screen.getByText(item.name)).toBeInTheDocument()
    }
  })
})
