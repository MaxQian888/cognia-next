import {
  appDefaultBelongsToExternalAgent,
  externalAgentAppDefault,
  resolveAppDefaultModel,
} from "./app-default-model"
import { externalAgentProviderId } from "@/lib/ai/agent/external/session-models"

const PI = externalAgentProviderId("pi-rpc")
const AGENT_MODEL = "commandcode/meta/muse-spark-1.3-contributor"

describe("appDefaultBelongsToExternalAgent", () => {
  it("is false for an ordinary provider default", () => {
    expect(
      appDefaultBelongsToExternalAgent({ defaultModel: "gpt-4.1", defaultProvider: "openai" })
    ).toBe(false)
  })

  it("is false when nothing is set", () => {
    expect(appDefaultBelongsToExternalAgent(undefined)).toBe(false)
    expect(appDefaultBelongsToExternalAgent({})).toBe(false)
  })

  it("is true for a scoped marker and for the legacy unscoped one", () => {
    expect(appDefaultBelongsToExternalAgent({ defaultProvider: PI })).toBe(true)
    expect(appDefaultBelongsToExternalAgent({ defaultProvider: "cognia:external-agent" })).toBe(
      true
    )
  })
})

describe("resolveAppDefaultModel", () => {
  it("passes an ordinary provider default straight through", () => {
    expect(resolveAppDefaultModel({ defaultModel: "gpt-4.1", defaultProvider: "openai" })).toEqual({
      model: "gpt-4.1",
      provider: "openai",
    })
  })

  it("treats a blank model as unset rather than as an empty id", () => {
    expect(resolveAppDefaultModel({ defaultModel: "   ", defaultProvider: "openai" })).toEqual({
      model: undefined,
      provider: "openai",
    })
  })

  it("resolves an agent-owned default away on the provider lane", () => {
    // The reported bug: the Built-in Agent Runtime page rendered this model id
    // as the SDK sidecar's default even though no provider can serve it.
    expect(resolveAppDefaultModel({ defaultModel: AGENT_MODEL, defaultProvider: PI })).toEqual({
      model: undefined,
      provider: undefined,
    })
  })

  it("returns the model to the agent that owns it", () => {
    expect(
      resolveAppDefaultModel(
        { defaultModel: AGENT_MODEL, defaultProvider: PI },
        { forExternalAgentId: "pi-rpc" }
      )
    ).toEqual({ model: AGENT_MODEL, provider: undefined })
  })

  it("never hands the marker back as a provider id", () => {
    const resolved = resolveAppDefaultModel(
      { defaultModel: AGENT_MODEL, defaultProvider: PI },
      { forExternalAgentId: "pi-rpc" }
    )
    expect(resolved.provider).toBeUndefined()
  })

  it("withholds one agent's model from a different agent", () => {
    expect(
      resolveAppDefaultModel(
        { defaultModel: AGENT_MODEL, defaultProvider: PI },
        { forExternalAgentId: "codex" }
      )
    ).toEqual({ model: undefined, provider: undefined })
  })

  it("withholds a legacy unscoped marker from every agent", () => {
    // It names no agent, so nothing can prove the model was ever offered.
    expect(
      resolveAppDefaultModel(
        { defaultModel: AGENT_MODEL, defaultProvider: "cognia:external-agent" },
        { forExternalAgentId: "pi-rpc" }
      )
    ).toEqual({ model: undefined, provider: undefined })
  })

  it("round-trips an agent id that needed encoding in the marker", () => {
    const weird = externalAgentProviderId("my agent/1")
    expect(
      resolveAppDefaultModel(
        { defaultModel: AGENT_MODEL, defaultProvider: weird },
        { forExternalAgentId: "my agent/1" }
      )
    ).toEqual({ model: AGENT_MODEL, provider: undefined })
  })
})

describe("externalAgentAppDefault", () => {
  it("is null for an ordinary provider default", () => {
    expect(
      externalAgentAppDefault({ defaultModel: "gpt-4.1", defaultProvider: "openai" })
    ).toBeNull()
  })

  it("names the agent holding the app-wide default", () => {
    expect(externalAgentAppDefault({ defaultModel: AGENT_MODEL, defaultProvider: PI })).toEqual({
      agentId: "pi-rpc",
      model: AGENT_MODEL,
      provider: PI,
    })
  })

  it("reports a marker with no model as a real state", () => {
    expect(externalAgentAppDefault({ defaultProvider: PI })).toEqual({
      agentId: "pi-rpc",
      model: undefined,
      provider: PI,
    })
  })

  it("reports the legacy unscoped marker with a null agent id", () => {
    expect(
      externalAgentAppDefault({
        defaultModel: AGENT_MODEL,
        defaultProvider: "cognia:external-agent",
      })
    ).toEqual({ agentId: null, model: AGENT_MODEL, provider: "cognia:external-agent" })
  })
})
