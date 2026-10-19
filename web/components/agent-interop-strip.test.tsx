import { render, screen, within } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { AgentInteropStrip } from "./agent-interop-strip"

const copy = en.home.run.agents

describe("AgentInteropStrip", () => {
  it("indexes the agents it interoperates with", () => {
    render(<AgentInteropStrip copy={copy} />)
    const list = screen.getByRole("list", { name: copy.label })
    expect(within(list).getAllByRole("listitem")).toHaveLength(copy.items.length)
    for (const agent of copy.items) {
      expect(within(list).getByText(agent.name)).toBeInTheDocument()
    }
  })

  it("states each agent's capability in words rather than implying it", () => {
    // The point of the block is that it is not a logo wall: the presence of a
    // mark must never be what communicates support.
    render(<AgentInteropStrip copy={copy} />)
    const rows = within(screen.getByRole("list", { name: copy.label })).getAllByRole("listitem")
    copy.items.forEach((agent, index) => {
      const row = rows[index]
      expect(within(row).queryAllByText(copy.runLabel).length).toBe(agent.run ? 1 : 0)
      expect(within(row).queryAllByText(copy.importLabel).length).toBe(agent.import ? 1 : 0)
      // A row claiming neither capability would be asserting a connection that
      // does not exist.
      expect(agent.run || agent.import).toBe(true)
    })
  })

  it("paints its cells in the surrounding section's tone", () => {
    const { container, rerender } = render(<AgentInteropStrip copy={copy} />)
    expect(container.querySelector("li")).toHaveClass("bg-paper")
    rerender(<AgentInteropStrip copy={copy} tone="surface" />)
    expect(container.querySelector("li")).toHaveClass("bg-surface")
  })

  it("keeps the capability labels at a readable size", () => {
    const { container } = render(<AgentInteropStrip copy={copy} />)
    expect(container.querySelector(".text-\\[10px\\]")).toBeNull()
  })

  it("localises the agent index", () => {
    render(<AgentInteropStrip copy={zh.home.run.agents} />)
    expect(screen.getByRole("list", { name: zh.home.run.agents.label })).toBeInTheDocument()
    expect(screen.getByText(zh.home.run.agents.note)).toBeInTheDocument()
  })
})
