/** @jest-environment jsdom */

// The phone body of `/agents` (ADR-0220): the header bar (title, count, back
// target, new button) around the shared `AgentsView`.

import { fireEvent, render, screen } from "@testing-library/react"

import type { AgentsRouteState } from "@/hooks/agents/use-agents-route-state"

import { AgentsMobileBody } from "./agents-mobile-body"

let mockModel: Record<string, unknown> = {}
jest.mock("@/hooks/agents/use-agents-console-model", () => ({
  useAgentsConsoleModel: () => mockModel,
}))

let viewProps: Record<string, unknown> = {}
jest.mock("@/components/agents/agents-view", () => ({
  AgentsView: (props: Record<string, unknown>) => {
    viewProps = props
    return <div data-testid="agents-view" />
  },
}))

function route(over: Partial<AgentsRouteState> = {}): AgentsRouteState {
  return {
    view: { kind: "list" },
    query: "",
    source: "all",
    sort: "recent",
    openList: jest.fn(),
    openAgent: jest.fn(),
    setMode: jest.fn(),
    openCreate: jest.fn(),
    openBuilder: jest.fn(),
    setQuery: jest.fn(),
    setSource: jest.fn(),
    setSort: jest.fn(),
    ...over,
  }
}

beforeEach(() => {
  viewProps = {}
  mockModel = { agents: [{ id: "a" }, { id: "b" }, { id: "c" }] }
})

describe("AgentsMobileBody header", () => {
  it("titles the list Agents with the count and a new button, and no back", () => {
    const r = route()
    render(<AgentsMobileBody route={r} />)
    expect(screen.getByRole("heading", { name: "Agents" })).toBeInTheDocument()
    expect(screen.getByText("3 agents")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "New agent" }))
    expect(r.openCreate).toHaveBeenCalledWith("1")
  })

  it.each([
    ["no agents", []],
    ["the first read in flight", undefined],
  ])("falls back to the description with %s", (_n, agents) => {
    mockModel = { agents }
    render(<AgentsMobileBody route={route()} />)
    expect(screen.getByText(/Reusable agents with their own instructions/)).toBeInTheDocument()
  })

  it("keeps the Agents title on an agent's detail", () => {
    render(
      <AgentsMobileBody route={route({ view: { kind: "detail", id: "a", mode: "overview" } })} />
    )
    expect(screen.getByRole("heading", { name: "Agents" })).toBeInTheDocument()
  })

  it.each([
    ["create chooser", { kind: "create", mode: "1" }],
    ["blank create", { kind: "create", mode: "blank" }],
    ["builder", { kind: "builder", sessionId: "s" }],
  ] as const)("uses the create title in the %s", (_n, view) => {
    render(<AgentsMobileBody route={route({ view })} />)
    expect(screen.getByRole("heading", { name: "Create an agent" })).toBeInTheDocument()
  })

  it.each([
    ["detail", { kind: "detail", id: "a", mode: "overview" }],
    ["create", { kind: "create", mode: "1" }],
  ] as const)("hides the count and the new button in the %s view", (_n, view) => {
    render(<AgentsMobileBody route={route({ view })} />)
    expect(screen.queryByText("3 agents")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "New agent" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument()
  })
})

describe("AgentsMobileBody back target", () => {
  it.each(["blank", "ai"] as const)("returns from create %s to the chooser", (mode) => {
    const r = route({ view: { kind: "create", mode } })
    render(<AgentsMobileBody route={r} />)
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(r.openCreate).toHaveBeenCalledWith("1")
    expect(r.openList).not.toHaveBeenCalled()
  })

  it("returns from the create chooser to the list", () => {
    const r = route({ view: { kind: "create", mode: "1" } })
    render(<AgentsMobileBody route={r} />)
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(r.openList).toHaveBeenCalled()
    expect(r.openCreate).not.toHaveBeenCalled()
  })

  it("returns from the builder to the builder setup", () => {
    const r = route({ view: { kind: "builder", sessionId: "s" } })
    render(<AgentsMobileBody route={r} />)
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(r.openCreate).toHaveBeenCalledWith("ai")
  })

  it("returns from detail edit to the overview", () => {
    const r = route({ view: { kind: "detail", id: "a", mode: "edit" } })
    render(<AgentsMobileBody route={r} />)
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(r.setMode).toHaveBeenCalledWith("overview")
    expect(r.openList).not.toHaveBeenCalled()
  })

  it("returns from the detail overview to the list", () => {
    const r = route({ view: { kind: "detail", id: "a", mode: "overview" } })
    render(<AgentsMobileBody route={r} />)
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(r.openList).toHaveBeenCalled()
  })
})

describe("AgentsMobileBody body", () => {
  it("renders the shared view in compact layout", () => {
    const r = route()
    render(<AgentsMobileBody route={r} />)
    expect(screen.getByTestId("agents-mobile-body")).toBeInTheDocument()
    expect(screen.getByTestId("agents-view")).toBeInTheDocument()
    expect(viewProps.route).toBe(r)
    expect(viewProps.model).toBe(mockModel)
    expect(viewProps.compact).toBe(true)
  })
})
