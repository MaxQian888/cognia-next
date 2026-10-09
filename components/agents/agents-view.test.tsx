/** @jest-environment jsdom */

// The centre of the agents console for each URL view (ADR-0220). Every child
// surface is stubbed to a probe that records its props, so each case proves
// which surface the view picks and how the route is wired into it.

import { fireEvent, render, screen } from "@testing-library/react"

import type { AgentsRouteState } from "@/hooks/agents/use-agents-route-state"
import type { AgentsConsoleModel } from "@/hooks/agents/use-agents-console-model"

import { AgentsView } from "./agents-view"

jest.mock("@/components/mobile/mobile-spot-icon", () => ({
  MobileSpotIcon: () => <span data-testid="spot-icon" />,
}))

let builderProps: { sessionId: string; onOpenAgent: (id: string) => void; onLeave: () => void }
jest.mock("./builder/agent-builder-workspace", () => ({
  AgentBuilderWorkspace: (props: typeof builderProps) => {
    builderProps = props
    return <div data-testid="builder-workspace" data-session={props.sessionId} />
  },
}))

let setupProps: { onStart: (id: string) => void }
jest.mock("./builder/agent-builder-setup", () => ({
  AgentBuilderSetup: (props: typeof setupProps) => {
    setupProps = props
    return <div data-testid="builder-setup" />
  },
}))

let blankProps: {
  catalogs: unknown
  onCreated: (agent: { id: string }) => void
  onCancel: () => void
}
jest.mock("./create/agent-blank-create", () => ({
  AgentBlankCreate: (props: typeof blankProps) => {
    blankProps = props
    return <div data-testid="blank-create" />
  },
}))

let chooserProps: {
  mode: string
  agentCount: number
  onBlank: () => void
  onBuildWithAi: () => void
  onResumeDraft: (id: string) => void
}
jest.mock("./create/agent-create-chooser", () => ({
  AgentCreateChooser: (props: typeof chooserProps) => {
    chooserProps = props
    return <div data-testid="chooser" data-mode={props.mode} />
  },
}))

let detailProps: Record<string, unknown> & {
  onModeChange: (mode: string) => void
  onOpenAgent: (id: string) => void
  onDeleted: () => void
  onStartChat: (agent: { id: string }) => void
}
jest.mock("./detail/agent-detail-view", () => ({
  AgentDetailView: (props: typeof detailProps) => {
    detailProps = props
    return <div data-testid="detail-view" />
  },
}))

let listPaneProps: Record<string, unknown> & {
  onSelect: (id: string) => void
  onCreate: () => void
}
jest.mock("./agent-list-pane", () => ({
  AgentListPane: (props: typeof listPaneProps) => {
    listPaneProps = props
    return <div data-testid="list-pane" data-variant={String(props.variant)} />
  },
}))

function route(over: Partial<AgentsRouteState> = {}): AgentsRouteState {
  return {
    view: { kind: "list" },
    query: "q",
    source: "user",
    sort: "name",
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

const alpha = { id: "alpha", name: "Alpha" }
const startChat = jest.fn(async () => {})

function model(over: Partial<AgentsConsoleModel> = {}): AgentsConsoleModel {
  return {
    agents: [alpha, { id: "beta", name: "Beta" }] as never,
    summaries: new Map(),
    liveCount: 0,
    catalogs: { skills: [], mcpServers: [], knowledgeBases: [] } as never,
    selected: alpha as never,
    selectedSiblingPending: 2,
    startChat,
    startingChat: true,
    ...over,
  }
}

describe("AgentsView builder", () => {
  it("opens the builder workspace on the session", () => {
    const r = route({ view: { kind: "builder", sessionId: "s1" } })
    render(<AgentsView route={r} model={model()} compact={false} />)
    expect(screen.getByTestId("builder-workspace")).toHaveAttribute("data-session", "s1")
  })

  it("opens a created agent and leaves to the create chooser", () => {
    const r = route({ view: { kind: "builder", sessionId: "s1" } })
    render(<AgentsView route={r} model={model()} compact={false} />)
    builderProps.onOpenAgent("alpha")
    expect(r.openAgent).toHaveBeenCalledWith("alpha")
    builderProps.onLeave()
    expect(r.openCreate).toHaveBeenCalledWith("1")
  })

  it("does not wait for the agents list", () => {
    render(
      <AgentsView
        route={route({ view: { kind: "builder", sessionId: "s1" } })}
        model={model({ agents: undefined })}
        compact={false}
      />
    )
    expect(screen.getByTestId("builder-workspace")).toBeInTheDocument()
  })
})

describe("AgentsView create", () => {
  it("shows the chooser in create mode with the agent count", () => {
    const r = route({ view: { kind: "create", mode: "1" } })
    render(<AgentsView route={r} model={model()} compact={false} />)
    expect(chooserProps.mode).toBe("create")
    expect(chooserProps.agentCount).toBe(2)
    chooserProps.onBlank()
    expect(r.openCreate).toHaveBeenCalledWith("blank")
    chooserProps.onBuildWithAi()
    expect(r.openCreate).toHaveBeenCalledWith("ai")
    chooserProps.onResumeDraft("draft-1")
    expect(r.openBuilder).toHaveBeenCalledWith("draft-1")
  })

  it("counts zero agents while the list is still loading", () => {
    render(
      <AgentsView
        route={route({ view: { kind: "create", mode: "1" } })}
        model={model({ agents: undefined })}
        compact={false}
      />
    )
    expect(screen.getByTestId("chooser")).toBeInTheDocument()
    expect(chooserProps.agentCount).toBe(0)
  })

  it("wraps blank create in a back bar on desktop", () => {
    const r = route({ view: { kind: "create", mode: "blank" } })
    render(<AgentsView route={r} model={model()} compact={false} />)
    expect(screen.getByTestId("agents-create-blank")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Start blank" })).toBeInTheDocument()
    expect(screen.getByTestId("blank-create")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("agents-create-back"))
    expect(screen.getByRole("button", { name: "Back" })).toBe(
      screen.getByTestId("agents-create-back")
    )
    expect(r.openCreate).toHaveBeenCalledWith("1")
  })

  it("wires blank create to the catalogs, open-on-created and cancel", () => {
    const m = model()
    const r = route({ view: { kind: "create", mode: "blank" } })
    render(<AgentsView route={r} model={m} compact={false} />)
    expect(blankProps.catalogs).toBe(m.catalogs)
    blankProps.onCreated({ id: "new-agent" })
    expect(r.openAgent).toHaveBeenCalledWith("new-agent")
    blankProps.onCancel()
    expect(r.openCreate).toHaveBeenCalledWith("1")
  })

  it("wraps builder setup in a titled back bar on desktop", () => {
    const r = route({ view: { kind: "create", mode: "ai" } })
    render(<AgentsView route={r} model={model()} compact={false} />)
    expect(screen.getByTestId("agents-create-ai")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Build with AI" })).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("agents-create-back"))
    expect(r.openCreate).toHaveBeenCalledWith("1")
    setupProps.onStart("sess-7")
    expect(r.openBuilder).toHaveBeenCalledWith("sess-7")
  })

  it.each(["blank", "ai"] as const)("renders %s bare on compact", (mode) => {
    render(<AgentsView route={route({ view: { kind: "create", mode } })} model={model()} compact />)
    expect(screen.getByTestId(mode === "ai" ? "builder-setup" : "blank-create")).toBeInTheDocument()
    expect(screen.queryByTestId("agents-create-back")).not.toBeInTheDocument()
    expect(screen.queryByTestId(`agents-create-${mode}`)).not.toBeInTheDocument()
  })
})

describe("AgentsView loading", () => {
  it.each([
    ["list", { kind: "list" }],
    ["detail", { kind: "detail", id: "alpha", mode: "overview" }],
  ] as const)("shows a spinner in the %s view until agents arrive", (_n, view) => {
    render(
      <AgentsView route={route({ view })} model={model({ agents: undefined })} compact={false} />
    )
    expect(screen.getByText("Loading agents…")).toBeInTheDocument()
    expect(screen.queryByTestId("chooser")).not.toBeInTheDocument()
    expect(screen.queryByTestId("detail-view")).not.toBeInTheDocument()
  })
})

describe("AgentsView detail", () => {
  it("says so when the agent is gone and goes back to the list", () => {
    const r = route({ view: { kind: "detail", id: "ghost", mode: "overview" } })
    render(<AgentsView route={r} model={model({ selected: null })} compact={false} />)
    expect(screen.getByTestId("agent-not-found")).toBeInTheDocument()
    expect(screen.getByText("Agent not found")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "All agents" }))
    expect(r.openList).toHaveBeenCalled()
    expect(screen.queryByTestId("detail-view")).not.toBeInTheDocument()
  })

  it("shows the agent's detail with the model's state", () => {
    const m = model()
    const r = route({ view: { kind: "detail", id: "alpha", mode: "edit" } })
    render(<AgentsView route={r} model={m} compact={false} />)
    expect(screen.getByTestId("detail-view")).toBeInTheDocument()
    expect(detailProps.agent).toBe(alpha)
    expect(detailProps.agents).toBe(m.agents)
    expect(detailProps.catalogs).toBe(m.catalogs)
    expect(detailProps.mode).toBe("edit")
    expect(detailProps.compact).toBe(false)
    expect(detailProps.starting).toBe(true)
    expect(detailProps.siblingPendingCount).toBe(2)
  })

  it("passes compact through to the detail", () => {
    render(
      <AgentsView
        route={route({ view: { kind: "detail", id: "alpha", mode: "overview" } })}
        model={model()}
        compact
      />
    )
    expect(detailProps.compact).toBe(true)
  })

  it("wires the detail's callbacks into the route", () => {
    const r = route({ view: { kind: "detail", id: "alpha", mode: "overview" } })
    render(<AgentsView route={r} model={model()} compact={false} />)
    detailProps.onModeChange("edit")
    expect(r.setMode).toHaveBeenCalledWith("edit")
    detailProps.onOpenAgent("beta")
    expect(r.openAgent).toHaveBeenCalledWith("beta")
    detailProps.onDeleted()
    expect(r.openList).toHaveBeenCalled()
    detailProps.onStartChat(alpha)
    expect(startChat).toHaveBeenCalledWith(alpha)
  })
})

describe("AgentsView list", () => {
  it("shows the home chooser with the agent count on desktop", () => {
    const r = route()
    render(<AgentsView route={r} model={model()} compact={false} />)
    expect(screen.getByTestId("chooser")).toHaveAttribute("data-mode", "home")
    expect(chooserProps.agentCount).toBe(2)
    chooserProps.onBlank()
    expect(r.openCreate).toHaveBeenCalledWith("blank")
    chooserProps.onBuildWithAi()
    expect(r.openCreate).toHaveBeenCalledWith("ai")
    chooserProps.onResumeDraft("d")
    expect(r.openBuilder).toHaveBeenCalledWith("d")
  })

  it("makes the list the root page on compact", () => {
    const m = model()
    const r = route()
    render(<AgentsView route={r} model={m} compact />)
    expect(screen.getByTestId("list-pane")).toHaveAttribute("data-variant", "page")
    expect(screen.queryByTestId("chooser")).not.toBeInTheDocument()
    expect(listPaneProps.agents).toBe(m.agents)
    expect(listPaneProps.summaries).toBe(m.summaries)
    expect(listPaneProps.query).toBe("q")
    expect(listPaneProps.source).toBe("user")
    expect(listPaneProps.sort).toBe("name")
    expect(listPaneProps.onQueryChange).toBe(r.setQuery)
    expect(listPaneProps.onSourceChange).toBe(r.setSource)
    expect(listPaneProps.onSortChange).toBe(r.setSort)
    listPaneProps.onSelect("beta")
    expect(r.openAgent).toHaveBeenCalledWith("beta")
    listPaneProps.onCreate()
    expect(r.openCreate).toHaveBeenCalledWith("1")
  })
})
