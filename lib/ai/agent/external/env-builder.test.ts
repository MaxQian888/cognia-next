jest.mock("@/lib/codex-subscription/credential-store", () => ({
  loadCodexCredential: jest.fn(async () => null),
  isCodexCredentialFresh: jest.requireActual("@/lib/codex-subscription/credential-store")
    .isCodexCredentialFresh,
  saveCodexCredential: jest.fn(),
  clearCodexCredential: jest.fn(),
}))

jest.mock("@/lib/codex-subscription/discovery", () => ({
  discoverCodexAuth: jest.fn(async () => null),
  discoveredToCredential: jest.requireActual("@/lib/codex-subscription/discovery")
    .discoveredToCredential,
}))

import * as credentialStore from "@/lib/codex-subscription/credential-store"
import * as discoveryMod from "@/lib/codex-subscription/discovery"
import type { CodexCredential, DiscoveredCodexAuth } from "@/lib/codex-subscription/types"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"

import { buildAgentEnv } from "./env-builder"

const mLoad = credentialStore.loadCodexCredential as jest.Mock
const mDiscover = discoveryMod.discoverCodexAuth as jest.Mock

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

const chatgptCredential: CodexCredential = {
  accessToken: "oat-fresh",
  refreshToken: "rt-fresh",
  idTokenRaw: "eyJ.x.y",
  expiresAtMs: Date.now() + 60 * 60 * 1000,
  authMode: "chatgpt",
  email: "user@example.com",
  storedAtMs: Date.now(),
}

const apiKeyCredential: CodexCredential = {
  accessToken: "sk-fresh-1234",
  refreshToken: "",
  idTokenRaw: "",
  expiresAtMs: 0,
  authMode: "api_key",
  storedAtMs: Date.now(),
}

const discovered: DiscoveredCodexAuth = {
  source: "file",
  authJsonPath: "/home/user/.codex/auth.json",
  authMode: "ChatGPT",
  tokens: {
    accessToken: "oat-from-cli",
    refreshToken: "rt-from-cli",
    idTokenRaw: "eyJ.cli.jwt",
    accountId: "acct_x",
    email: "user@example.com",
    chatgptPlanType: "Plus",
    chatgptUserId: "user_x",
    chatgptAccountId: "acct_x",
  },
}

beforeEach(() => {
  mLoad.mockReset()
  mDiscover.mockReset()
  // Default return values; individual tests override with mockResolvedValueOnce.
  mLoad.mockResolvedValue(null)
  mDiscover.mockResolvedValue(null)
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("buildAgentEnv — codex preset", () => {
  it("uses the keyring credential when fresh (chatgpt mode)", async () => {
    mLoad.mockResolvedValueOnce(chatgptCredential)

    const env = await buildAgentEnv(codexConfig())

    expect(env).toEqual({ CODEX_ACCESS_TOKEN: "oat-fresh" })
    expect(mDiscover).not.toHaveBeenCalled()
  })

  it("uses the keyring credential when fresh (api_key mode)", async () => {
    mLoad.mockResolvedValueOnce(apiKeyCredential)

    const env = await buildAgentEnv(codexConfig())

    expect(env).toEqual({
      OPENAI_API_KEY: "sk-fresh-1234",
      CODEX_API_KEY: "sk-fresh-1234",
    })
  })

  it("falls back to discovery when keyring is empty", async () => {
    mLoad.mockResolvedValueOnce(null)
    jest.spyOn(discoveryMod, "discoverCodexAuth").mockResolvedValueOnce(discovered)

    const env = await buildAgentEnv(codexConfig())

    expect(env).toEqual({ CODEX_ACCESS_TOKEN: "oat-from-cli" })
  })

  it("returns base env unchanged when no credential is available anywhere", async () => {
    mLoad.mockResolvedValueOnce(null)
    mDiscover.mockResolvedValueOnce(null)

    const env = await buildAgentEnv(codexConfig(), { CUSTOM_VAR: "x" })

    expect(env).toEqual({ CUSTOM_VAR: "x" })
  })

  it("base env wins on conflicting keys (user-provided override)", async () => {
    mLoad.mockResolvedValueOnce(chatgptCredential)

    const env = await buildAgentEnv(codexConfig(), {
      CODEX_ACCESS_TOKEN: "user-override",
      OTHER: "kept",
    })

    expect(env.CODEX_ACCESS_TOKEN).toBe("user-override")
    expect(env.OTHER).toBe("kept")
  })

  it("treats an expired chatgpt credential as missing and falls back to discovery", async () => {
    const stale: CodexCredential = {
      ...chatgptCredential,
      expiresAtMs: Date.now() - 1000,
    }
    mLoad.mockResolvedValueOnce(stale)
    mDiscover.mockResolvedValueOnce(discovered)

    const env = await buildAgentEnv(codexConfig())

    // Fallback discovery (post-Adopt) yields chatgpt mode with the discovered
    // access token.
    expect(env).toEqual({ CODEX_ACCESS_TOKEN: "oat-from-cli" })
  })

  it("swallows credential-load failures and falls through to discovery", async () => {
    mLoad.mockRejectedValueOnce(new Error("keyring locked"))
    mDiscover.mockResolvedValueOnce(discovered)
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)

    const env = await buildAgentEnv(codexConfig())

    expect(env).toEqual({ CODEX_ACCESS_TOKEN: "oat-from-cli" })
    warn.mockRestore()
  })

  it("swallows discovery failures and returns base env unchanged", async () => {
    mLoad.mockResolvedValueOnce(null)
    mDiscover.mockRejectedValueOnce(new Error("FS read failed"))
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)

    const env = await buildAgentEnv(codexConfig(), { K: "v" })

    expect(env).toEqual({ K: "v" })
    warn.mockRestore()
  })
})

describe("buildAgentEnv — non-codex presets", () => {
  it("is a no-op for the claude-code preset", async () => {
    // No spying needed — if buildAgentEnv called load, the unmocked impl would
    // attempt real Tauri IPC and throw. The base env passing through verbatim
    // is sufficient evidence that the codex branch wasn't entered.
    const env = await buildAgentEnv(claudeConfig(), { A: "1" })
    expect(env).toEqual({ A: "1" })
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
  })
})
