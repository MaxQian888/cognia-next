import { render, screen } from "@testing-library/react"
import { RunsTab } from "./runs-tab"

const liveRef = { value: undefined as unknown }
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => liveRef.value,
}))
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

function row(over: Record<string, unknown> = {}) {
  return {
    id: "r1",
    workflowId: "wf1",
    status: "succeeded",
    triggerKind: "trigger.manual",
    startedAt: 0,
    workflowSnapshot: { id: "wf1", name: "Nightly sync" },
    ...over,
  }
}

beforeEach(() => {
  liveRef.value = undefined
})

describe("RunsTab", () => {
  it("shows skeletons while loading", () => {
    liveRef.value = undefined
    const { container } = render(<RunsTab />)
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
  })

  it("shows the empty state when there are no runs", () => {
    liveRef.value = []
    render(<RunsTab />)
    expect(screen.getByText("No runs yet")).toBeInTheDocument()
  })

  it("renders the generated run title when present", () => {
    liveRef.value = [row({ title: "Synced 3 inbox messages" })]
    render(<RunsTab />)
    expect(screen.getByText("Synced 3 inbox messages")).toBeInTheDocument()
    expect(screen.queryByText("Nightly sync")).not.toBeInTheDocument()
  })

  it("falls back to the workflow snapshot name when there is no run title", () => {
    liveRef.value = [row()]
    render(<RunsTab />)
    expect(screen.getByText("Nightly sync")).toBeInTheDocument()
  })
})
