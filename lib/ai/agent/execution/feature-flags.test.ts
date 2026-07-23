/** @jest-environment jsdom */
import {
  AGENT_EXECUTION_FLAGS,
  getAgentExecutionFlags,
  isAgentExecutionFlagEnabled,
} from "./feature-flags"

const STORAGE_KEY = "cognia-agent-execution-flags-v1"

describe("agent execution feature flags", () => {
  const envKeys = [
    "NEXT_PUBLIC_AGENT_EXECUTION_RESOLVER_V2",
    "NEXT_PUBLIC_GENERIC_AGENT_HOST_COMMANDS",
    "NEXT_PUBLIC_GATEWAY_AGENT_ROUTE_TICKETS",
    "NEXT_PUBLIC_HEADLESS_LLM_GATEWAY",
    "NEXT_PUBLIC_EXPERIMENTAL_ANTHROPIC_DEPLOYMENT_AGENT_SDK",
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
    process.env.NEXT_PUBLIC_HEADLESS_LLM_GATEWAY = "banana"

    const flags = getAgentExecutionFlags()
    expect(flags.agentExecutionResolverV2).toBe(true)
    expect(flags.gatewayAgentRouteTickets).toBe(true)
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
})
