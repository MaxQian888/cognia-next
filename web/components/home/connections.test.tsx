import { fireEvent, render, screen, within } from "@testing-library/react"
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
    // Scoped to the receipts list: the agent-interop index below it is its own
    // list, and counting every listitem in the section would conflate the two.
    render(<Connections copy={en.home.connections} />)
    const lists = screen.getAllByRole("list")
    expect(within(lists[0]).getAllByRole("listitem")).toHaveLength(4)
  })

  it("answers reads, can act and requires approval for each one", () => {
    render(<Connections copy={en.home.connections} />)
    const items = within(screen.getAllByRole("list")[0]).getAllByRole("listitem")
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

  it("highlights the matching receipt when a flow source receives focus", () => {
    render(<Connections copy={en.home.connections} flowCopy={en.home.connectionFlow} />)
    const flow = screen.getByRole("group", { name: en.home.connectionFlow.label })
    const source = within(flow).getByRole("button", { name: en.home.connections.items[0].name })
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
    render(<Connections copy={zh.home.connections} />)
    for (const item of zh.home.connections.items) {
      expect(screen.getByText(item.name)).toBeInTheDocument()
    }
  })

  it("indexes the agents it interoperates with", () => {
    render(<Connections copy={en.home.connections} />)
    const list = screen.getByRole("list", { name: en.home.connections.agents.label })
    const rows = within(list).getAllByRole("listitem")
    expect(rows).toHaveLength(en.home.connections.agents.items.length)
    for (const agent of en.home.connections.agents.items) {
      expect(within(list).getByText(agent.name)).toBeInTheDocument()
    }
  })

  it("states each agent's capability in words rather than implying it", () => {
    // The point of the block is that it is not a logo wall: the presence of a
    // mark must never be what communicates support.
    render(<Connections copy={en.home.connections} />)
    const list = screen.getByRole("list", { name: en.home.connections.agents.label })
    const rows = within(list).getAllByRole("listitem")
    en.home.connections.agents.items.forEach((agent, index) => {
      const row = rows[index]
      const runs = within(row).queryAllByText(en.home.connections.agents.runLabel)
      const imports = within(row).queryAllByText(en.home.connections.agents.importLabel)
      expect(runs.length).toBe(agent.run ? 1 : 0)
      expect(imports.length).toBe(agent.import ? 1 : 0)
      // A row claiming neither capability would be asserting a connection that
      // does not exist.
      expect(agent.run || agent.import).toBe(true)
    })
  })

  it("localises the agent index", () => {
    render(<Connections copy={zh.home.connections} />)
    expect(screen.getByRole("list", { name: zh.home.connections.agents.label })).toBeInTheDocument()
    expect(screen.getByText(zh.home.connections.agents.note)).toBeInTheDocument()
  })
})
