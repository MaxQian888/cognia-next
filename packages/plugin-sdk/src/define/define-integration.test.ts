import { defineIntegration } from "./define-integration"

describe("defineIntegration", () => {
  it("preserves a complete declarative integration definition", () => {
    const integration = defineIntegration({
      id: "example",
      label: "Example",
      authStrategies: [
        {
          id: "oauth",
          type: "oauth2",
          label: "OAuth",
          providerId: "example-oauth",
          scopes: ["read"],
        },
      ],
      resourceKinds: ["issue"],
      eventTypes: [
        {
          id: "issue.updated",
          label: "Issue updated",
          resourceKinds: ["issue"],
        },
      ],
      actions: [
        {
          id: "issue.comment",
          label: "Comment",
          handler: "commentIssue",
          inputSchema: { type: "object" },
          risk: "write",
          idempotency: "supported",
        },
      ],
    })

    expect(integration.id).toBe("example")
    expect(integration.actions[0].risk).toBe("write")
  })
})
