import { render, screen } from "@testing-library/react"
import GithubDeliveryPage from "./page"

let mockOrders: unknown = null
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockOrders,
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    table: () => ({
      orderBy: () => ({
        reverse: () => ({ toArray: async () => [] }),
      }),
    }),
  }),
}))

describe("GithubDeliveryPage", () => {
  it("renders the plugin-not-enabled empty state when getDb fails (returns null)", () => {
    mockOrders = null
    const { container } = render(<GithubDeliveryPage />)
    expect(screen.getByText(/plugin is not enabled/)).toBeInTheDocument()
    // Wallpaper-scope marker so the chat-scoped background reaches this surface.
    expect(container.querySelector("main[data-bg-target='chat']")).not.toBeNull()
  })

  it("renders the 6 kanban columns when orders are loaded", () => {
    mockOrders = [
      {
        id: 1,
        repoFullName: "octocat/hello",
        issueNumber: 7,
        status: "in_progress",
        aiDriver: "claude-code",
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: 2,
        repoFullName: "octocat/hello",
        issueNumber: 8,
        status: "failed",
        lastError: "boom",
        createdAt: 0,
        updatedAt: 0,
      },
    ]
    render(<GithubDeliveryPage />)
    const kanban = screen.getByTestId("github-delivery-kanban")
    expect(kanban).toBeInTheDocument()
    expect(kanban).toHaveAttribute("data-bg-target", "chat")
    expect(screen.getByTestId("kanban-col-open")).toBeInTheDocument()
    expect(screen.getByTestId("kanban-col-in_progress")).toBeInTheDocument()
    expect(screen.getByTestId("kanban-col-pr_opened")).toBeInTheDocument()
    expect(screen.getByTestId("kanban-col-awaiting_review")).toBeInTheDocument()
    expect(screen.getByTestId("kanban-col-merged")).toBeInTheDocument()
    expect(screen.getByTestId("kanban-col-failed")).toBeInTheDocument()
    expect(screen.getByText("#7")).toBeInTheDocument()
    expect(screen.getByText("#8")).toBeInTheDocument()
    expect(screen.getByText("boom")).toBeInTheDocument()
  })

  it("renders the loading state while orders are undefined", () => {
    mockOrders = undefined
    render(<GithubDeliveryPage />)
    expect(screen.getByText(/Loading/)).toBeInTheDocument()
  })
})
