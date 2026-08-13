import type { ResolvedConfig } from "../../config/schema"
import { resolveWorkerExecutionProfile } from "./resolve-worker-execution"

const config = {
  provider: "openai",
  providers: { openai: { apiKey: "secret" } },
  model: "gpt-test",
  agentBackend: "builtin",
  cwd: "/tmp/repo",
  permissionMode: "default",
  builtinTools: {},
} as unknown as ResolvedConfig

describe("resolveWorkerExecutionProfile", () => {
  it("derives the manifest profile and RPC spec from one canonical resolution", () => {
    const resolved = resolveWorkerExecutionProfile(config, {
      sessionId: "session-1",
      runId: "run-1",
    })

    expect(resolved.profile).toEqual({
      profileVersion: 1,
      backendId: "builtin",
      runtimeAdapter: resolved.spec.runtimeAdapter,
      modelBindings: resolved.spec.modelBindings,
      deploymentRefs: ["provider:openai"],
      capabilities: resolved.spec.capabilities.effective,
    })
    expect(resolved.spec).toMatchObject({
      specVersion: 2,
      deploymentRef: "provider:openai",
      modelBindings: { primary: "gpt-test" },
      credential: { profileRef: "credential:openai" },
      identity: { sessionId: "session-1", runId: "run-1" },
    })
  })

  it("does not advertise a credential reference for an unconfigured provider", () => {
    const resolved = resolveWorkerExecutionProfile({
      ...config,
      providers: { openai: {} },
    })
    expect(resolved.spec.credential).toBeUndefined()
  })

  it("supports auth-token credentials and provider model fallback", () => {
    const resolved = resolveWorkerExecutionProfile({
      ...config,
      model: undefined,
      providers: { openai: { authToken: "token", model: "provider-model" } },
    } as ResolvedConfig)
    expect(resolved.spec.modelBindings.primary).toBe("provider-model")
    expect(resolved.spec.credential?.profileRef).toBe("credential:openai")
  })

  it("uses an unknown model sentinel only when no configured or catalog model exists", () => {
    const resolved = resolveWorkerExecutionProfile({
      ...config,
      provider: "custom-provider",
      model: undefined,
      providers: { "custom-provider": {} },
    } as unknown as ResolvedConfig)
    expect(resolved.spec.modelBindings.primary).toBe("unknown")
  })

  it("maps a registered external backend through the same canonical resolver", () => {
    const resolved = resolveWorkerExecutionProfile({
      ...config,
      agentBackend: "codex",
    } as ResolvedConfig)
    expect(resolved.backend.kind).toBe("external")
    expect(resolved.profile.backendId).toBe("codex")
    expect(resolved.spec.runtimeAdapter).toBe("external")
  })

  it("fails fast when the selected CLI backend does not exist", () => {
    expect(() =>
      resolveWorkerExecutionProfile({
        ...config,
        agentBackend: "missing-backend",
      } as ResolvedConfig)
    ).toThrow('unknown backend "missing-backend"')
  })
})
