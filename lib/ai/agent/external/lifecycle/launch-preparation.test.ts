import type { KeyringStore } from "@/lib/credentials/keyring-store"
import { ExternalAgentLifecycleError } from "@/types/agent/external-agent-lifecycle"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"

import {
  __resetLaunchPreparationForTests,
  applyStateIsolation,
  isStateIsolated,
  prepareExternalAgentLaunch,
  prepareExternalAgentLaunchWithDefaults,
  stateIsolationBlockReason,
} from "./launch-preparation"

const keyringLoad = jest.fn()
jest.mock("@/lib/credentials/keyring-store", () => ({
  createKeyringStore: jest.fn(() => ({
    load: (id: string) => keyringLoad(id),
    save: jest.fn(),
    delete: jest.fn(),
  })),
}))

function config(overrides: Partial<ExternalAgentConfig> = {}): ExternalAgentConfig {
  return {
    id: "agent_1",
    name: "Codex",
    protocol: "codex-app-server",
    transport: "stdio",
    enabled: true,
    process: { command: "codex", args: ["app-server"], env: { LOG: "1" } },
    ...overrides,
  } as ExternalAgentConfig
}

function keyring(entries: Record<string, string>): KeyringStore {
  return {
    load: async (id: string) => entries[id] ?? null,
    save: jest.fn(),
    delete: jest.fn(),
  } as unknown as KeyringStore
}

beforeEach(() => {
  keyringLoad.mockReset()
  __resetLaunchPreparationForTests()
})

describe("stateIsolationBlockReason", () => {
  it("has nothing to say about a shared or an isolatable configuration", () => {
    expect(isStateIsolated(config())).toBe(false)
    expect(stateIsolationBlockReason(config())).toBeNull()
    expect(stateIsolationBlockReason(config({ stateIsolation: "isolated" }))).toBeNull()
  })

  it("refuses a runtime with no documented home to move", () => {
    expect(
      stateIsolationBlockReason(
        config({ stateIsolation: "isolated", process: { command: "goose", args: ["acp"] } })
      )
    ).toMatch(/goose/)
  })

  it("refuses an id that cannot name a directory", () => {
    expect(stateIsolationBlockReason(config({ id: "../x", stateIsolation: "isolated" }))).toMatch(
      /cannot name a state root/
    )
  })

  it("does not apply where there is no local runtime state to move", () => {
    const network = config({
      stateIsolation: "isolated",
      transport: "http",
      process: undefined,
      network: { endpoint: "http://x" },
    })
    expect(stateIsolationBlockReason(network)).toBeNull()
    const gateway = config({
      stateIsolation: "isolated",
      process: { command: "goose" },
      metadata: { cogniaGatewayTask: true },
    })
    expect(stateIsolationBlockReason(gateway)).toBeNull()
    const bot = config({
      stateIsolation: "isolated",
      process: { command: "goose", env: { COGNIA_BOT_ISOLATION: "1" } },
    })
    expect(stateIsolationBlockReason(bot)).toBeNull()
  })
})

describe("applyStateIsolation", () => {
  it("asks for the private root and drops the home variables the rule owns", () => {
    const prepared = applyStateIsolation(
      config({
        stateIsolation: "isolated",
        process: { command: "codex", env: { CODEX_HOME: "/tmp/old", LOG: "1" } },
      })
    )
    expect(prepared.process?.env).toEqual({ LOG: "1", COGNIA_AGENT_STATE_KEY: "agent_1" })
  })

  it("removes a stale key from a shared configuration", () => {
    const prepared = applyStateIsolation(
      config({ process: { command: "codex", env: { COGNIA_AGENT_STATE_KEY: "agent_1" } } })
    )
    expect(prepared.process?.env).toEqual({})
  })

  it("throws state_isolation_unsupported for a runtime it cannot isolate", () => {
    expect(() =>
      applyStateIsolation(config({ stateIsolation: "isolated", process: { command: "goose" } }))
    ).toThrow(ExternalAgentLifecycleError)
    try {
      applyStateIsolation(config({ stateIsolation: "isolated", process: { command: "goose" } }))
    } catch (error) {
      expect((error as ExternalAgentLifecycleError).code).toBe("state_isolation_unsupported")
    }
  })

  it("isolates an npx-launched runtime by its package", () => {
    const prepared = applyStateIsolation(
      config({
        stateIsolation: "isolated",
        process: { command: "npx", args: ["-y", "@zed-industries/codex-acp"] },
      })
    )
    expect(prepared.process?.env?.COGNIA_AGENT_STATE_KEY).toBe("agent_1")
  })
})

describe("prepareExternalAgentLaunch", () => {
  it("launches with the configuration's own keyring secrets", async () => {
    const prepared = await prepareExternalAgentLaunch(
      {
        ...config({ process: { command: "codex", env: { LOG: "1" } } }),
        credentialRefs: { processEnv: "agent_1:processEnv" },
      } as ExternalAgentConfig,
      { keyring: keyring({ "agent_1:processEnv": JSON.stringify({ OPENAI_API_KEY: "sk-a" }) }) }
    )
    expect(prepared.process?.env).toEqual({ LOG: "1", OPENAI_API_KEY: "sk-a" })
  })

  it("fails loudly instead of launching as nobody when a secret is gone", async () => {
    await expect(
      prepareExternalAgentLaunch(
        {
          ...config(),
          credentialRefs: { apiKey: "agent_1:apiKey" },
        } as ExternalAgentConfig,
        { keyring: keyring({}) }
      )
    ).rejects.toMatchObject({ code: "credential_missing" })
  })

  it("is idempotent", async () => {
    const deps = { keyring: keyring({ "agent_1:serverPassword": "pw" }) }
    const input = {
      ...config({ stateIsolation: "isolated" }),
      credentialRefs: { serverPassword: "agent_1:serverPassword" },
    } as ExternalAgentConfig
    const once = await prepareExternalAgentLaunch(input, deps)
    const twice = await prepareExternalAgentLaunch(once, deps)
    expect(twice).toEqual(once)
    expect(once.metadata?.serverPassword).toBe("pw")
  })
})

describe("prepareExternalAgentLaunchWithDefaults", () => {
  it("never opens the keyring for a configuration without stored secrets", async () => {
    const prepared = await prepareExternalAgentLaunchWithDefaults(
      config({ stateIsolation: "isolated" })
    )
    expect(prepared.process?.env?.COGNIA_AGENT_STATE_KEY).toBe("agent_1")
    expect(keyringLoad).not.toHaveBeenCalled()
  })

  it("resolves stored secrets through the default keyring", async () => {
    keyringLoad.mockResolvedValue("token")
    const prepared = await prepareExternalAgentLaunchWithDefaults({
      ...config({
        transport: "http",
        process: undefined,
        network: { endpoint: "http://x" },
      }),
      credentialRefs: { bearerToken: "agent_1:bearerToken" },
    } as ExternalAgentConfig)
    expect(keyringLoad).toHaveBeenCalledWith("agent_1:bearerToken")
    expect(prepared.network?.bearerToken).toBe("token")
  })
})
