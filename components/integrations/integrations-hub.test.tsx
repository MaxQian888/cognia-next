import { fireEvent, render, screen } from "@testing-library/react"
import { IntegrationsHub } from "./integrations-hub"

let mockPlatform = "tauri"
let mockHasEntries = true
let mockAccounts: unknown[] = []

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => [mockAccounts, [], [], []],
}))
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: () => mockPlatform,
}))
jest.mock("@/lib/integrations/registry", () => ({
  getIntegrationRegistryRevision: () => 1,
  subscribeIntegrationRegistry: () => () => undefined,
  listRegisteredIntegrationEntries: () => (mockHasEntries ? MOCK_ENTRIES : []),
}))

const MOCK_ENTRIES = [
  {
    pluginId: "demo-delivery",
    definition: {
      id: "demo",
      label: "Demo Delivery",
      description: "Demo integration",
      authStrategies: [
        {
          id: "token",
          type: "personal-access-token",
          label: "Token",
          providerId: "demo-token",
          configSchema: {
            type: "object",
            required: ["token"],
            properties: {
              token: { type: "string", format: "secret" },
              hostUrl: { type: "string", title: "Enterprise server URL" },
            },
          },
        },
        {
          id: "pat",
          type: "personal-access-token",
          label: "Advanced token",
          providerId: "demo-pat",
        },
      ],
      resourceKinds: ["workspace"],
      eventTypes: [{ id: "issue.created", label: "Issue created" }],
      actions: [
        {
          id: "issue.create",
          label: "Create issue",
          risk: "write",
          inputSchema: { type: "object" },
          idempotency: "supported",
          handler: "createIssue",
        },
      ],
    },
  },
]

beforeEach(() => {
  mockPlatform = "tauri"
  mockHasEntries = true
  mockAccounts = []
})

describe("IntegrationsHub", () => {
  it("renders registered Marketplace integrations and host-owned management sections", () => {
    render(<IntegrationsHub />)
    expect(screen.getByRole("heading", { name: "Integrations" })).toBeInTheDocument()
    expect(screen.getAllByText("Demo Delivery")).not.toHaveLength(0)
    expect(screen.getByText("Accounts")).toBeInTheDocument()
    expect(screen.getByText("Subscriptions")).toBeInTheDocument()
    expect(screen.getByText("Approvals and jobs")).toBeInTheDocument()
    expect(screen.getByText("Audit")).toBeInTheDocument()
  })

  it("gives the page one h1 and each management section a real h2", () => {
    // The four sections used to be `<Card>`s whose titles were spans wearing
    // `role="heading"`, and the page title was a hand-rolled <h1> in the
    // scroll body rather than the shared header band. The outline is what a
    // screen reader navigates by, so it is pinned here.
    render(<IntegrationsHub />)
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1)
    const sections = screen
      .getAllByRole("heading", { level: 2 })
      .map((node) => node.textContent?.trim())
    expect(sections).toEqual(["Accounts", "Subscriptions", "Approvals and jobs", "Audit"])
  })

  it("guides authentication configuration instead of asking for raw provider IDs", () => {
    render(<IntegrationsHub />)
    fireEvent.change(screen.getByLabelText("Integration"), {
      target: { value: "demo-delivery:demo" },
    })
    expect(screen.getByRole("button", { name: /Token Recommended/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Advanced token Advanced/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Token Recommended/ }))
    expect(screen.getByLabelText("Personal access token")).toHaveAttribute("type", "password")
    expect(screen.queryByPlaceholderText("Auth provider ID")).not.toBeInTheDocument()
  })

  it("offers the enterprise server field and says that leaving it empty is fine", () => {
    // ADR-0176. The one field here where blank is the common, correct answer.
    // A bare label cannot say so, and a user who types github.com into it has
    // been given a worse account than one who left it alone.
    render(<IntegrationsHub />)
    fireEvent.change(screen.getByLabelText("Integration"), {
      target: { value: "demo-delivery:demo" },
    })
    fireEvent.click(screen.getByRole("button", { name: /Token Recommended/ }))

    const field = screen.getByLabelText("Enterprise server URL")
    expect(field).toHaveAttribute("type", "text")
    expect(field).not.toBeRequired()
    expect(screen.getByText(/Leave empty for github\.com/)).toBeInTheDocument()
  })

  it("points at the marketplace instead of an account form with nothing to pick", () => {
    mockHasEntries = false
    render(<IntegrationsHub />)
    expect(screen.getByRole("link", { name: "Browse plugins" })).toHaveAttribute(
      "href",
      "/plugins?section=discover"
    )
    expect(screen.queryByLabelText("Integration")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Validate and add" })).not.toBeInTheDocument()
    expect(screen.getByText("Install an integration plugin to add an account.")).toBeInTheDocument()
  })

  it("asks for an account before offering a subscription form", () => {
    render(<IntegrationsHub />)
    expect(screen.queryByRole("button", { name: "Add subscription" })).not.toBeInTheDocument()
    expect(
      screen.getByText("Add an account first, then subscribe to its events.")
    ).toBeInTheDocument()
  })

  it("offers the subscription form once an account exists", () => {
    mockAccounts = [
      {
        id: "acc1",
        pluginId: "demo-delivery",
        integrationId: "demo",
        label: "Work",
        enabled: true,
        health: "healthy",
      },
    ]
    render(<IntegrationsHub />)
    expect(screen.getByRole("button", { name: "Add subscription" })).toBeEnabled()
    // No account picked yet: the events legend waits for one instead of
    // heading an empty list.
    expect(screen.queryByText("Events")).not.toBeInTheDocument()
  })

  it("makes the whole account form inert where it cannot be submitted", () => {
    mockPlatform = "web"
    render(<IntegrationsHub />)
    expect(screen.getByText("Integration management requires the desktop app.")).toBeInTheDocument()
    expect(screen.getByLabelText("Integration")).toBeDisabled()
    expect(screen.getByLabelText("Account label")).toBeDisabled()
    expect(screen.getByRole("button", { name: "Validate and add" })).toBeDisabled()
  })

  it("names the authentication step only once an integration is picked", () => {
    render(<IntegrationsHub />)
    expect(screen.queryByText("Authentication method")).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Integration"), {
      target: { value: "demo-delivery:demo" },
    })
    expect(screen.getByText("Authentication method")).toBeInTheDocument()
  })
})
