jest.mock("@cognia/redact", () => {
  const actual = jest.requireActual("@cognia/redact")
  return { ...actual, hasNoLeakingPiiDeep: jest.fn(actual.hasNoLeakingPiiDeep) }
})

import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { WorkbenchPiiGateBlocked, gateWorkbenchProviderPayload } from "./provider-payload"

describe("Context Workbench provider payload PII gate", () => {
  beforeEach(() => {
    jest.mocked(hasNoLeakingPiiDeep).mockClear()
  })

  it("redacts assembled resource, message, and system text after assembly", () => {
    const payload = gateWorkbenchProviderPayload(
      {
        content: "Contact jane@example.com",
        messages: [{ role: "user", content: "Call +1 415 555 2671" }],
        sendOptions: { appendSystemPrompt: "Owner jane@example.com" },
      },
      "Selection: jane@example.com"
    )

    expect(JSON.stringify(payload)).not.toContain("jane@example.com")
    expect(JSON.stringify(payload)).not.toContain("415 555 2671")
    expect(hasNoLeakingPiiDeep).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.anything(), messages: expect.any(Array) })
    )
  })

  it("does not mutate the request or redact runtime credentials", () => {
    const source = {
      content: "jane@example.com",
      messages: [{ content: "jane@example.com" }],
      sendOptions: { env: { TOKEN: "jane@example.com" }, mcpServers: { local: { token: "abc" } } },
    }
    const gated = gateWorkbenchProviderPayload(source)
    expect(source.content).toBe("jane@example.com")
    expect(gated).not.toBe(source)
    expect(gated.sendOptions.env).toEqual({ TOKEN: "jane@example.com" })
    expect(gated.sendOptions.mcpServers).toEqual({ local: { token: "abc" } })
  })

  it("fails closed when the final provider-visible payload does not pass verification", () => {
    jest.mocked(hasNoLeakingPiiDeep).mockReturnValueOnce(false)

    expect(() =>
      gateWorkbenchProviderPayload({ content: "safe", messages: [], sendOptions: {} })
    ).toThrow(WorkbenchPiiGateBlocked)
  })
})
