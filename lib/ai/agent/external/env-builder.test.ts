jest.mock("@/lib/subscription/core/transport", () => ({
  getActiveAccount: jest.fn(),
}))

import * as transportMod from "@/lib/subscription/core/transport"
import type { ActiveSnapshot } from "@/lib/subscription/core/types"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"

import { buildAgentEnv } from "./env-builder"

const mGetActive = transportMod.getActiveAccount as jest.Mock

function codexConfig(overrides: Partial<ExternalAgentConfig> = {}): ExternalAgentConfig {
  return {
    id: "agent-codex",
    name: "Codex CLI",
    protocol: "acp",
    transport: "stdio",
    enabled: true,
    metadata: { preset: "codex" },
    ...overrides,
  } as ExternalAgentConfig
}

function claudeConfig(): ExternalAgentConfig {
  return {
    id: "agent-claude",
    name: "Claude Code",
    protocol: "acp",
    transport: "stdio",
    enabled: true,
    metadata: { preset: "claude-code" },
  } as ExternalAgentConfig
}

function snapshot(
  env: Array<[string, string]>,
  activeAccountId: string | undefined = "a1"
): ActiveSnapshot {
  return { activeAccountId, env }
}

beforeEach(() => {
  mGetActive.mockReset()
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("buildAgentEnv — codex preset", () => {
  it("uses the active codex account's env when one is registered", async () => {
    mGetActive.mockResolvedValueOnce(snapshot([["CODEX_ACCESS_TOKEN", "oat-fresh"]]))
    const env = await buildAgentEnv(codexConfig())
    expect(env).toEqual({ CODEX_ACCESS_TOKEN: "oat-fresh" })
    expect(mGetActive).toHaveBeenCalledWith("codex")
  })

  it("supports api_key mode (multiple env pairs)", async () => {
    mGetActive.mockResolvedValueOnce(
      snapshot([
        ["OPENAI_API_KEY", "sk-fresh-1234"],
        ["CODEX_API_KEY", "sk-fresh-1234"],
      ])
    )
    const env = await buildAgentEnv(codexConfig())
    expect(env).toEqual({
      OPENAI_API_KEY: "sk-fresh-1234",
      CODEX_API_KEY: "sk-fresh-1234",
    })
  })

  it("returns base env unchanged when no active codex account is registered", async () => {
    mGetActive.mockResolvedValueOnce({ activeAccountId: undefined, env: [] })
    const env = await buildAgentEnv(codexConfig(), { CUSTOM_VAR: "x" })
    expect(env).toEqual({ CUSTOM_VAR: "x" })
  })

  it("returns base env unchanged when the active snapshot has no env pairs", async () => {
    mGetActive.mockResolvedValueOnce(snapshot([]))
    const env = await buildAgentEnv(codexConfig(), { K: "v" })
    expect(env).toEqual({ K: "v" })
  })

  it("base env wins on conflicting keys (user-provided override)", async () => {
    mGetActive.mockResolvedValueOnce(snapshot([["CODEX_ACCESS_TOKEN", "vault-token"]]))
    const env = await buildAgentEnv(codexConfig(), {
      CODEX_ACCESS_TOKEN: "user-override",
      OTHER: "kept",
    })
    expect(env.CODEX_ACCESS_TOKEN).toBe("user-override")
    expect(env.OTHER).toBe("kept")
  })

  it("swallows subscription_get_active failures and returns base env", async () => {
    mGetActive.mockRejectedValueOnce(new Error("transport offline"))
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const env = await buildAgentEnv(codexConfig(), { K: "v" })
    expect(env).toEqual({ K: "v" })
    warn.mockRestore()
  })

  it("preserves insertion order from the Rust-side env pairs", async () => {
    mGetActive.mockResolvedValueOnce(
      snapshot([
        ["OPENAI_API_KEY", "k1"],
        ["CODEX_API_KEY", "k1"],
        ["OPENAI_BASE_URL", "https://example.com"],
      ])
    )
    const env = await buildAgentEnv(codexConfig())
    expect(Object.keys(env)).toEqual(["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"])
  })
})

describe("buildAgentEnv — non-codex presets", () => {
  it("is a no-op for the claude-code preset", async () => {
    const env = await buildAgentEnv(claudeConfig(), { A: "1" })
    expect(env).toEqual({ A: "1" })
    expect(mGetActive).not.toHaveBeenCalled()
  })

  it("is a no-op when metadata.preset is missing", async () => {
    const cfg: ExternalAgentConfig = {
      id: "x",
      name: "Custom",
      protocol: "acp",
      transport: "stdio",
      enabled: true,
    } as ExternalAgentConfig
    const env = await buildAgentEnv(cfg, { K: "v" })
    expect(env).toEqual({ K: "v" })
    expect(mGetActive).not.toHaveBeenCalled()
  })
})
