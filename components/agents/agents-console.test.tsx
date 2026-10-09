/** @jest-environment jsdom */

// The desktop agents console frame (ADR-0220): the header and what it calls,
// and which panes exist for each URL view. The centre (`AgentsView`), the
// rail (`AgentListPane`) and the model hook have suites of their own.

import { fireEvent, render, screen } from "@testing-library/react"

import type { AgentsRouteState } from "@/hooks/agents/use-agents-route-state"

import { AgentsConsole } from "./agents-console"
import { settingsHref } from "@/lib/settings/deep-link"

let mockModel: Record<string, unknown> = {}
jest.mock("@/hooks/agents/use-agents-console-model", () => ({
  useAgentsConsoleModel: () => mockModel,
}))

interface StubPane {
  label: string
  content: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  defaultSize?: number
  minSize?: number
}
let shellProps: { storageId?: string; leftPane?: StubPane; centerClassName?: string } = {}
jest.mock("@/components/feature-shell/feature-page-shell", () => ({
  FeaturePageShell: (props: {
    storageId?: string
    header: React.ReactNode
    leftPane?: StubPane
    centerClassName?: string
    children: React.ReactNode
  }) => {
    shellProps = props
    return (
      <div data-testid="shell">
        {props.header}
        {props.leftPane ? (
          <aside aria-label={props.leftPane.label} data-open={String(props.leftPane.open)}>
            {props.leftPane.content}
            <button type="button" onClick={() => props.leftPane?.onOpenChange?.(true)}>
              open-rail
            </button>
          </aside>
        ) : null}
        <main>{props.children}</main>
      </div>
    )
  },
}))

interface StubAction {
  id: string
  label: string
  href?: string
  onSelect?: () => void
  testId?: string
}
jest.mock("@/components/feature-shell/feature-page-header", () => ({
  FeaturePageHeader: ({
    title,
    description,
    summary,
    primaryAction,
    secondaryActions,
    testId,
  }: {
    title: string
    description: string
    summary?: string
    primaryAction: StubAction
    secondaryActions: StubAction[]
    testId: string
  }) => (
    <header data-testid={testId}>
      <h1>{title}</h1>
      <p data-testid="description">{description}</p>
      {summary ? <p data-testid="summary">{summary}</p> : null}
      {[primaryAction, ...secondaryActions].map((action) =>
        action.href ? (
          <a key={action.id} href={action.href} data-testid={action.testId}>
            {action.label}
          </a>
        ) : (
          <button
            key={action.id}
            type="button"
            data-testid={action.testId}
            onClick={action.onSelect}
          >
            {action.label}
          </button>
        )
      )}
    </header>
  ),
}))

jest.mock("@/components/mobile/mobile-spot-icon", () => ({
  MobileSpotIcon: ({ name }: { name: string }) => <span data-testid="spot-icon">{name}</span>,
}))

let listPaneProps: Record<string, unknown> = {}
jest.mock("./agent-list-pane", () => ({
  AgentListPane: (
    props: Record<string, unknown> & { onSelect: (id: string) => void; onCreate: () => void }
  ) => {
    listPaneProps = props
    return (
      <div data-testid="agent-list-pane">
        <button type="button" onClick={() => props.onSelect("agent-9")}>
          pick-agent
        </button>
        <button type="button" onClick={props.onCreate}>
          rail-create
        </button>
      </div>
    )
  },
}))

let viewProps: Record<string, unknown> = {}
jest.mock("./agents-view", () => ({
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

const agent = (id: string) => ({ id, name: id })

beforeEach(() => {
  shellProps = {}
  listPaneProps = {}
  viewProps = {}
  mockModel = {
    agents: [agent("a"), agent("b"), agent("c")],
    summaries: new Map(),
    liveCount: 1,
    catalogs: {},
    selected: null,
  }
})

describe("AgentsConsole header", () => {
  it("renders the title, description and the characters spot icon", () => {
    render(<AgentsConsole route={route()} />)
    expect(screen.getByRole("heading", { name: "Agents" })).toBeInTheDocument()
    expect(screen.getByTestId("description")).toHaveTextContent(/Reusable agents/)
    expect(screen.getByTestId("agents-header")).toBeInTheDocument()
    expect(shellProps.storageId).toBe("agents")
  })

  it("summarises the agents and how many are working", () => {
    render(<AgentsConsole route={route()} />)
    expect(screen.getByTestId("summary")).toHaveTextContent("3 agents · 1 working")
  })

  it("leaves out the working count when nothing is live", () => {
    mockModel.liveCount = 0
    render(<AgentsConsole route={route()} />)
    expect(screen.getByTestId("summary")).toHaveTextContent(/^3 agents$/)
  })

  it("shows no summary while there are no agents", () => {
    mockModel.agents = []
    render(<AgentsConsole route={route()} />)
    expect(screen.queryByTestId("summary")).not.toBeInTheDocument()
  })

  it("shows no summary while the first read is in flight", () => {
    mockModel.agents = undefined
    render(<AgentsConsole route={route()} />)
    expect(screen.queryByTestId("summary")).not.toBeInTheDocument()
  })

  it("opens blank create from the primary action", () => {
    const r = route()
    render(<AgentsConsole route={r} />)
    fireEvent.click(screen.getByTestId("agents-new"))
    expect(screen.getByTestId("agents-new")).toHaveTextContent("New agent")
    expect(r.openCreate).toHaveBeenCalledWith("blank")
  })

  it("opens the builder setup from Build with AI", () => {
    const r = route()
    render(<AgentsConsole route={r} />)
    fireEvent.click(screen.getByTestId("agents-build-with-ai"))
    expect(screen.getByTestId("agents-build-with-ai")).toHaveTextContent("Build with AI")
    expect(r.openCreate).toHaveBeenCalledWith("ai")
  })

  it("links Agent packs to the characters settings", () => {
    render(<AgentsConsole route={route()} />)
    const link = screen.getByTestId("agents-packs")
    expect(link).toHaveTextContent("Agent packs")
    expect(link).toHaveAttribute("href", settingsHref("characters"))
  })
})

describe("AgentsConsole panes", () => {
  it.each([
    ["list", { kind: "list" }],
    ["detail", { kind: "detail", id: "a", mode: "overview" }],
    ["create", { kind: "create", mode: "1" }],
  ] as const)("keeps the rail in the %s view", (_name, view) => {
    render(<AgentsConsole route={route({ view })} />)
    expect(screen.getByTestId("agent-list-pane")).toBeInTheDocument()
    expect(shellProps.leftPane?.label).toBe("Agents")
    expect(shellProps.leftPane?.defaultSize).toBe(24)
    expect(shellProps.leftPane?.minSize).toBe(16)
  })

  it("drops the rail for the builder conversation", () => {
    render(<AgentsConsole route={route({ view: { kind: "builder", sessionId: "s1" } })} />)
    expect(screen.queryByTestId("agent-list-pane")).not.toBeInTheDocument()
    expect(shellProps.leftPane).toBeUndefined()
    expect(screen.getByTestId("agents-view")).toBeInTheDocument()
  })

  it("renders the centre in the non-compact layout with the route and model", () => {
    const r = route()
    render(<AgentsConsole route={r} />)
    expect(viewProps.route).toBe(r)
    expect(viewProps.model).toBe(mockModel)
    expect(viewProps.compact).toBe(false)
    expect(shellProps.centerClassName).toBe("min-h-0")
  })

  it("gives the rail the model and the list state from the URL", () => {
    const r = route({ query: "rev", source: "user", sort: "name" })
    render(<AgentsConsole route={r} />)
    expect(listPaneProps.agents).toBe(mockModel.agents)
    expect(listPaneProps.summaries).toBe(mockModel.summaries)
    expect(listPaneProps.query).toBe("rev")
    expect(listPaneProps.source).toBe("user")
    expect(listPaneProps.sort).toBe("name")
    expect(listPaneProps.onQueryChange).toBe(r.setQuery)
    expect(listPaneProps.onSourceChange).toBe(r.setSource)
    expect(listPaneProps.onSortChange).toBe(r.setSort)
  })

  it("marks the open agent as selected in the rail only in the detail view", () => {
    const { unmount } = render(
      <AgentsConsole route={route({ view: { kind: "detail", id: "b", mode: "edit" } })} />
    )
    expect(listPaneProps.selectedId).toBe("b")
    unmount()
    render(<AgentsConsole route={route()} />)
    expect(listPaneProps.selectedId).toBeUndefined()
  })

  it("opens the picked agent from the rail", () => {
    const r = route()
    render(<AgentsConsole route={r} />)
    fireEvent.click(screen.getByRole("button", { name: "pick-agent" }))
    expect(r.openAgent).toHaveBeenCalledWith("agent-9")
  })

  it("opens the create chooser from the rail's create button", () => {
    const r = route()
    render(<AgentsConsole route={r} />)
    fireEvent.click(screen.getByRole("button", { name: "rail-create" }))
    expect(r.openCreate).toHaveBeenCalledWith("1")
  })

  it("closes the rail sheet once an agent is picked", () => {
    render(<AgentsConsole route={route()} />)
    const rail = screen.getByLabelText("Agents", { selector: "aside" })
    expect(rail).toHaveAttribute("data-open", "false")
    fireEvent.click(screen.getByRole("button", { name: "open-rail" }))
    expect(rail).toHaveAttribute("data-open", "true")
    fireEvent.click(screen.getByRole("button", { name: "pick-agent" }))
    expect(rail).toHaveAttribute("data-open", "false")
  })
})
