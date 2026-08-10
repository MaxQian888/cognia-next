import { guardWorkflowEgress, WorkflowPiiBlockedError } from "./egress-guard"

const sensitive = {
  piiEgressRequired: true,
  sourceTriggerKind: "trigger.connector.inbound" as const,
}

describe("guardWorkflowEgress", () => {
  it("forces block when a connector-origin formal run requests off", () => {
    expect(() =>
      guardWorkflowEgress({
        securityContext: sensitive,
        sink: "model",
        requestedMode: "off",
        value: { prompt: "email alice@example.com" },
      })
    ).toThrow(WorkflowPiiBlockedError)
  })

  it("defaults every external sink to block when no node policy is stored", () => {
    expect(() =>
      guardWorkflowEgress({
        sink: "connector",
        value: { content: "email alice@example.com" },
      })
    ).toThrow(WorkflowPiiBlockedError)
    expect(
      guardWorkflowEgress({ sink: "remote-tool", value: { query: "public release notes" } }).mode
    ).toBe("block")
  })

  it("redacts every nested string leaf without leaking the source", () => {
    const result = guardWorkflowEgress({
      securityContext: sensitive,
      sink: "remote-tool",
      requestedMode: "redact",
      value: { nested: ["alice@example.com", { phone: "+14155552671" }] },
    })

    expect(result.redacted).toBe(true)
    expect(JSON.stringify(result.value)).not.toContain("alice@example.com")
    expect(JSON.stringify(result.value)).not.toContain("14155552671")
  })

  it("keeps local or non-sensitive off-mode payloads unchanged", () => {
    const value = { email: "alice@example.com" }
    expect(guardWorkflowEgress({ sink: "model", requestedMode: "off", value }).value).toBe(value)
    expect(
      guardWorkflowEgress({
        securityContext: sensitive,
        sink: "local-tool",
        requestedMode: "off",
        value,
      }).value
    ).toBe(value)
  })

  it("exposes a stable non-retryable error code without source content", () => {
    try {
      guardWorkflowEgress({
        securityContext: sensitive,
        sink: "connector",
        value: "sk-abc1234567890abcdef1234567890abcdef",
      })
      throw new Error("expected guard to throw")
    } catch (error) {
      expect(error).toMatchObject({ code: "pii_blocked", retryable: false })
      expect(String(error)).not.toContain("sk-abc")
    }
  })
})
