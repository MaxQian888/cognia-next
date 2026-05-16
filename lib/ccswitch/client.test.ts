// IPC wrappers are thin — the only behaviour worth testing is that each
// function (a) gates on isTauri(), and (b) forwards through invoke() with
// the right command name and args.

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))

import { invoke } from "@tauri-apps/api/core"

import { isTauri } from "@/lib/tauri"

import {
  ccswitchListMcpServers,
  ccswitchListPrompts,
  ccswitchListProviders,
  ccswitchListSkills,
  ccswitchStatus,
  writeClaudeSettingsEnv,
  writeCodexAuthEnv,
} from "./client"

const mInvoke = invoke as jest.Mock
const mIsTauri = isTauri as jest.Mock

beforeEach(() => {
  jest.resetAllMocks()
  mIsTauri.mockReturnValue(true)
})

describe("ccswitch IPC wrappers", () => {
  it("ccswitchStatus invokes ccswitch_status", async () => {
    mInvoke.mockResolvedValue({
      dbPath: "/x",
      exists: false,
      counts: { providers: 0, mcpServers: 0, prompts: 0, skills: 0 },
    })
    const out = await ccswitchStatus()
    expect(mInvoke).toHaveBeenCalledWith("ccswitch_status")
    expect(out.exists).toBe(false)
  })

  it("ccswitchListProviders invokes ccswitch_list_providers", async () => {
    mInvoke.mockResolvedValue([])
    await ccswitchListProviders()
    expect(mInvoke).toHaveBeenCalledWith("ccswitch_list_providers")
  })

  it("ccswitchListMcpServers invokes ccswitch_list_mcp_servers", async () => {
    mInvoke.mockResolvedValue([])
    await ccswitchListMcpServers()
    expect(mInvoke).toHaveBeenCalledWith("ccswitch_list_mcp_servers")
  })

  it("ccswitchListPrompts invokes ccswitch_list_prompts", async () => {
    mInvoke.mockResolvedValue([])
    await ccswitchListPrompts()
    expect(mInvoke).toHaveBeenCalledWith("ccswitch_list_prompts")
  })

  it("ccswitchListSkills invokes ccswitch_list_skills", async () => {
    mInvoke.mockResolvedValue([])
    await ccswitchListSkills()
    expect(mInvoke).toHaveBeenCalledWith("ccswitch_list_skills")
  })

  it("writeClaudeSettingsEnv forwards the env-updates payload", async () => {
    mInvoke.mockResolvedValue({ path: "/u/.claude/settings.json" })
    const out = await writeClaudeSettingsEnv({
      ANTHROPIC_API_KEY: "sk-x",
      ANTHROPIC_BASE_URL: null,
    })
    expect(mInvoke).toHaveBeenCalledWith("write_claude_settings_env", {
      envUpdates: { ANTHROPIC_API_KEY: "sk-x", ANTHROPIC_BASE_URL: null },
    })
    expect(out.path).toBe("/u/.claude/settings.json")
  })

  it("writeCodexAuthEnv forwards the env-updates payload to write_codex_auth_env", async () => {
    mInvoke.mockResolvedValue({ path: "/u/.codex/auth.json" })
    const out = await writeCodexAuthEnv({
      OPENAI_API_KEY: "sk-openai",
    })
    expect(mInvoke).toHaveBeenCalledWith("write_codex_auth_env", {
      envUpdates: { OPENAI_API_KEY: "sk-openai" },
    })
    expect(out.path).toBe("/u/.codex/auth.json")
  })

  it("rejects every wrapper when not running in Tauri", async () => {
    mIsTauri.mockReturnValue(false)
    await expect(ccswitchStatus()).rejects.toThrow(/Tauri/)
    await expect(ccswitchListProviders()).rejects.toThrow(/Tauri/)
    await expect(ccswitchListMcpServers()).rejects.toThrow(/Tauri/)
    await expect(ccswitchListPrompts()).rejects.toThrow(/Tauri/)
    await expect(ccswitchListSkills()).rejects.toThrow(/Tauri/)
    await expect(writeClaudeSettingsEnv({})).rejects.toThrow(/Tauri/)
    await expect(writeCodexAuthEnv({})).rejects.toThrow(/Tauri/)
    expect(mInvoke).not.toHaveBeenCalled()
  })
})
