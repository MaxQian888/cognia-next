/**
 * @jest-environment node
 */
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import { backendIdentity, backendSegmentText } from "./backend-identity"

const base: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }

/** Mirror `loadConfig`'s promotion so `resolveActiveModel` sees the pin. */
function withModel(config: ResolvedConfig, model: string): ResolvedConfig {
  return {
    ...config,
    model,
    providers: { ...config.providers, [config.provider]: { model } },
  }
}

describe("backendIdentity", () => {
  it("shows the provider and its resolved model on the built-in agent", () => {
    expect(backendIdentity(withModel(base, "claude-opus-4-8"))).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-8",
      external: false,
    })
  })

  it("shows the backend instead of the provider when an external agent answers", () => {
    // The bug this replaces: `--backend codex` rendering "anthropic".
    expect(backendIdentity({ ...base, agentBackend: "codex" })).toEqual({
      provider: "codex",
      external: true,
    })
  })

  it("names the executable preset actually launched", () => {
    expect(backendIdentity({ ...base, agentBackend: "codex" }, "codex-app-server").provider).toBe(
      "codex (codex-app-server)"
    )
  })

  it("does not repeat the backend when the preset is the same", () => {
    expect(backendIdentity({ ...base, agentBackend: "claude-code" }, "claude-code").provider).toBe(
      "claude-code"
    )
  })

  it("omits the model rather than borrowing the built-in catalog default", () => {
    // The external agent picks its own model when we never named one; showing
    // anthropic's default here would be a fabricated fact.
    const identity = backendIdentity(withModel({ ...base, agentBackend: "codex" }, "opus"))
    expect(identity.model).toBe("opus")
    expect(backendIdentity({ ...base, agentBackend: "codex" }).model).toBeUndefined()
  })
})

describe("backendSegmentText", () => {
  it("renders nothing on the built-in agent and the backend id otherwise", () => {
    expect(backendSegmentText(base)).toBeNull()
    expect(backendSegmentText({ ...base, agentBackend: "builtin" })).toBeNull()
    expect(backendSegmentText({ ...base, agentBackend: "claude-code" })).toBe("claude-code")
  })
})
