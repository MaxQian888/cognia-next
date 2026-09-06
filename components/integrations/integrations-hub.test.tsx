import { fireEvent, render, screen } from "@testing-library/react"
import { IntegrationsHub } from "./integrations-hub"

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => [[], [], [], []],
}))
jest.mock("@/lib/integrations/registry", () => ({
  getIntegrationRegistryRevision: () => 1,
  subscribeIntegrationRegistry: () => () => undefined,
  listRegisteredIntegrationEntries: () => [
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
              properties: { token: { type: "string", format: "secret" } },
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
  ],
}))

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
})
