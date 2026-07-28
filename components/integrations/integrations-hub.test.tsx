import { render, screen } from "@testing-library/react"
import { IntegrationsHub } from "./integrations-hub"

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => [[], [], [], []],
}))
jest.mock("@/lib/integrations/registry", () => ({
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
})
