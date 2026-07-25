/**
 * @jest-environment node
 */
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import {
  backendContextWindow,
  backendIdentity,
  backendModelMetaTarget,
  backendSegmentText,
} from "./backend-identity"

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
    expect(backendIdentity({ ...base, agentBackend: "codex" }).model).toBeUndefined()
  })

  it("reads the external model from the per-backend memory, not the legacy pin", () => {
    // The regression: `config.model` is the legacy global pin and still carries
    // the built-in provider's id, so reading it here rendered "claude-opus-4-8"
    // as the model Codex was running.
    const stale = withModel({ ...base, agentBackend: "codex" }, "claude-opus-4-8")
    expect(backendIdentity(stale).model).toBeUndefined()
    expect(
      backendIdentity({ ...stale, agentBackends: { codex: { model: "gpt-5.2-codex" } } }).model
    ).toBe("gpt-5.2-codex")
  })

  it("prefers the launched preset's remembered model over the alias's", () => {
    const config: ResolvedConfig = {
      ...base,
      agentBackend: "codex",
      agentBackends: { codex: { model: "alias-model" }, "codex-app-server": { model: "gpt-5.6" } },
    }
    expect(backendIdentity(config, "codex-app-server").model).toBe("gpt-5.6")
    expect(backendIdentity(config).model).toBe("alias-model")
  })
})

describe("backendModelMetaTarget", () => {
  it("routes native Codex metadata through Codex's model, not the chat provider", () => {
    const config: ResolvedConfig = {
      ...base,
      provider: "anthropic",
      agentBackend: "codex",
      agentBackends: { "codex-app-server": { model: "gpt-5.6-sol" } },
    }
    expect(backendModelMetaTarget(config, "codex-app-server")).toEqual({
      provider: "codex",
      model: "gpt-5.6-sol",
    })
  })

  it("keeps the built-in provider/model pair unchanged", () => {
    expect(backendModelMetaTarget(withModel(base, "claude-x"))).toEqual({
      provider: "anthropic",
      model: "claude-x",
    })
  })
})

describe("backendContextWindow", () => {
  it("honours a positive resolved window on any backend", () => {
    expect(backendContextWindow(base, 1_000_000)).toBe(1_000_000)
    expect(backendContextWindow({ ...base, agentBackend: "codex" }, 400_000)).toBe(400_000)
  })

  it("falls back to the pattern table only on the built-in agent", () => {
    // "claude-x" matches no pattern → the conservative 128k default.
    expect(backendContextWindow(withModel(base, "claude-x"))).toBe(128_000)
  })

  it("reports no window for an external agent nothing resolved one for", () => {
    // Sizing a gauge from the built-in provider's table here would describe a
    // model this session is not running.
    const codex = withModel({ ...base, agentBackend: "codex" }, "claude-opus-4-8")
    expect(backendContextWindow(codex)).toBeUndefined()
    expect(backendContextWindow(codex, 0)).toBeUndefined()
  })
})

describe("backendSegmentText", () => {
  it("renders nothing on the built-in agent and the backend id otherwise", () => {
    expect(backendSegmentText(base)).toBeNull()
    expect(backendSegmentText({ ...base, agentBackend: "builtin" })).toBeNull()
    expect(backendSegmentText({ ...base, agentBackend: "claude-code" })).toBe("claude-code")
  })
})
