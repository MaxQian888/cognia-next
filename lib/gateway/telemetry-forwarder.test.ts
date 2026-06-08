import { forwardGatewayOutcome, gatewayOutcomeToProviderOutcome } from "./telemetry-forwarder"
import { recordProviderOutcome } from "@/lib/claude/provider-telemetry"
import type { GatewayRequestOutcome } from "@/types/gateway"

jest.mock("@/lib/claude/provider-telemetry", () => ({
  recordProviderOutcome: jest.fn(),
}))

const base: GatewayRequestOutcome = {
  providerId: "openai",
  modelId: "gpt-4o",
  ok: true,
  latencyMs: 120,
  inputTokens: 10,
  outputTokens: 5,
  errorMessage: null,
}

describe("gatewayOutcomeToProviderOutcome", () => {
  it("sums tokens and maps the core fields", () => {
    expect(gatewayOutcomeToProviderOutcome(base)).toEqual({
      providerId: "openai",
      modelId: "gpt-4o",
      ok: true,
      latencyMs: 120,
      tokensUsed: 15,
    })
  })

  it("omits tokensUsed when both token counts are null", () => {
    const o = gatewayOutcomeToProviderOutcome({
      ...base,
      inputTokens: null,
      outputTokens: null,
    })
    expect("tokensUsed" in o).toBe(false)
  })

  it("carries the error message on failures", () => {
    const o = gatewayOutcomeToProviderOutcome({
      ...base,
      ok: false,
      errorMessage: "HTTP 429",
    })
    expect(o.ok).toBe(false)
    expect(o.errorMessage).toBe("HTTP 429")
  })

  it("treats a single present token count as a partial sum", () => {
    expect(gatewayOutcomeToProviderOutcome({ ...base, outputTokens: null }).tokensUsed).toBe(10)
  })
})

describe("forwardGatewayOutcome", () => {
  it("records the mapped outcome into the telemetry sink", () => {
    ;(recordProviderOutcome as jest.Mock).mockClear()
    forwardGatewayOutcome(base)
    expect(recordProviderOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "openai", tokensUsed: 15 })
    )
  })
})
