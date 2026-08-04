/** @jest-environment jsdom */
import {
  AGENT_EXECUTION_FLAGS,
  getAgentExecutionFlags,
  isAgentExecutionFlagEnabled,
  setAgentExecutionFlag,
  subscribeToAgentExecutionFlags,
} from "./feature-flags"

const STORAGE_KEY = "cognia-agent-execution-flags-v1"

describe("agent execution feature flags", () => {
  const envKeys = [
    "NEXT_PUBLIC_AGENT_EXECUTION_RESOLVER_V2",
    "NEXT_PUBLIC_GENERIC_AGENT_HOST_COMMANDS",
    "NEXT_PUBLIC_GATEWAY_AGENT_ROUTE_TICKETS",
    "NEXT_PUBLIC_HEADLESS_LLM_GATEWAY",
    "NEXT_PUBLIC_EXPERIMENTAL_ANTHROPIC_DEPLOYMENT_AGENT_SDK",
    "NEXT_PUBLIC_CLAUDE_SDK_PARITY_V1",
    "NEXT_PUBLIC_CLAUDE_SDK_SESSION_STORE",
    "NEXT_PUBLIC_CLAUDE_SDK_CHECKPOINT",
    "NEXT_PUBLIC_CLAUDE_SDK_PREWARM",
  ] as const

  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    window.localStorage.clear()
  })

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    window.localStorage.clear()
  })

  it("defaults every flag to OFF", () => {
    const flags = getAgentExecutionFlags()
    for (const flag of AGENT_EXECUTION_FLAGS) {
      expect(flags[flag]).toBe(false)
    }
  })

  it("env vars override defaults ('1'/'true' on, '0'/'false' off, junk ignored)", () => {
    process.env.NEXT_PUBLIC_AGENT_EXECUTION_RESOLVER_V2 = "1"
    process.env.NEXT_PUBLIC_GATEWAY_AGENT_ROUTE_TICKETS = "true"
    process.env.NEXT_PUBLIC_CLAUDE_SDK_PARITY_V1 = "true"
    process.env.NEXT_PUBLIC_HEADLESS_LLM_GATEWAY = "banana"

    const flags = getAgentExecutionFlags()
    expect(flags.agentExecutionResolverV2).toBe(true)
    expect(flags.gatewayAgentRouteTickets).toBe(true)
    expect(flags.claudeSdkParityV1).toBe(true)
    expect(flags.headlessLlmGateway).toBe(false)
    expect(flags.genericAgentHostCommands).toBe(false)
  })

  it("localStorage overrides env", () => {
    process.env.NEXT_PUBLIC_AGENT_EXECUTION_RESOLVER_V2 = "0"
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        agentExecutionResolverV2: true,
        experimentalAnthropicDeploymentAgentSdk: true,
      })
    )

    expect(isAgentExecutionFlagEnabled("agentExecutionResolverV2")).toBe(true)
    expect(isAgentExecutionFlagEnabled("experimentalAnthropicDeploymentAgentSdk")).toBe(true)
  })

  it("ignores malformed localStorage payloads and non-boolean values", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json")
    expect(isAgentExecutionFlagEnabled("agentExecutionResolverV2")).toBe(false)

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ agentExecutionResolverV2: "yes", unknownFlag: true })
    )
    expect(isAgentExecutionFlagEnabled("agentExecutionResolverV2")).toBe(false)
  })

  describe("setAgentExecutionFlag", () => {
    it("turns a flag on and back off through the localStorage layer", () => {
      expect(isAgentExecutionFlagEnabled("gatewayAgentRouteTickets")).toBe(false)

      setAgentExecutionFlag("gatewayAgentRouteTickets", true)
      expect(isAgentExecutionFlagEnabled("gatewayAgentRouteTickets")).toBe(true)

      setAgentExecutionFlag("gatewayAgentRouteTickets", false)
      expect(isAgentExecutionFlagEnabled("gatewayAgentRouteTickets")).toBe(false)
    })

    it("preserves other stored overrides when writing one flag", () => {
      setAgentExecutionFlag("agentExecutionResolverV2", true)
      setAgentExecutionFlag("gatewayAgentRouteTickets", true)

      const flags = getAgentExecutionFlags()
      expect(flags.agentExecutionResolverV2).toBe(true)
      expect(flags.gatewayAgentRouteTickets).toBe(true)
    })

    it("writes an explicit false that overrides an env-enabled flag", () => {
      // The stored layer sits ABOVE env, so a user turning the toggle off must
      // win over a build that shipped the flag on.
      process.env.NEXT_PUBLIC_GATEWAY_AGENT_ROUTE_TICKETS = "1"
      expect(isAgentExecutionFlagEnabled("gatewayAgentRouteTickets")).toBe(true)

      setAgentExecutionFlag("gatewayAgentRouteTickets", false)
      expect(isAgentExecutionFlagEnabled("gatewayAgentRouteTickets")).toBe(false)
    })

    it("notifies subscribers so a UI can read through useSyncExternalStore", () => {
      const listener = jest.fn()
      const unsubscribe = subscribeToAgentExecutionFlags(listener)

      setAgentExecutionFlag("gatewayAgentRouteTickets", true)
      expect(listener).toHaveBeenCalledTimes(1)

      setAgentExecutionFlag("gatewayAgentRouteTickets", false)
      expect(listener).toHaveBeenCalledTimes(2)

      unsubscribe()
      setAgentExecutionFlag("gatewayAgentRouteTickets", true)
      expect(listener).toHaveBeenCalledTimes(2)
    })

    it("still notifies when the write itself failed, so the UI can snap back", () => {
      const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("QuotaExceededError")
      })
      const listener = jest.fn()
      const unsubscribe = subscribeToAgentExecutionFlags(listener)

      setAgentExecutionFlag("gatewayAgentRouteTickets", true)

      expect(listener).toHaveBeenCalled()
      expect(isAgentExecutionFlagEnabled("gatewayAgentRouteTickets")).toBe(false)

      unsubscribe()
      setItem.mockRestore()
    })

    it("survives a throwing localStorage rather than propagating", () => {
      const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("QuotaExceededError")
      })

      expect(() => setAgentExecutionFlag("gatewayAgentRouteTickets", true)).not.toThrow()
      expect(isAgentExecutionFlagEnabled("gatewayAgentRouteTickets")).toBe(false)

      setItem.mockRestore()
    })
  })
})
