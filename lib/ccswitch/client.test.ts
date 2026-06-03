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
  ccswitchWatchStart,
  ccswitchWatchStop,
  writeClaudeSettingsEnv,
  writeCodexAuthEnv,
  writeGeminiSettingsEnv,
  writeOpencodeAuthEnv,
} from "./client"

const mInvoke = invoke as jest.Mock
const mIsTauri = isTauri as jest.Mock

beforeEach(() => {
  jest.resetAllMocks()
  mIsTauri.mockReturnValue(true)
})

describe("ccswitch IPC wrappers", () => {
  it("ccswitchStatus invokes ccswitch_status with no manual dir by default", async () => {
    mInvoke.mockResolvedValue({
      dbPath: "/x",
      exists: false,
      counts: { providers: 0, mcpServers: 0, prompts: 0, skills: 0 },
    })
    const out = await ccswitchStatus()
    expect(mInvoke).toHaveBeenCalledWith("ccswitch_status", {})
    expect(out.exists).toBe(false)
  })

  it("ccswitchStatus threads a manual data dir when provided", async () => {
    mInvoke.mockResolvedValue({ exists: true, counts: {} })
    await ccswitchStatus("  ~/cc-data  ")
    expect(mInvoke).toHaveBeenCalledWith("ccswitch_status", { manualDataDir: "~/cc-data" })
  })

  it("ccswitchStatus drops a blank manual data dir", async () => {
    mInvoke.mockResolvedValue({ exists: true, counts: {} })
    await ccswitchStatus("   ")
    expect(mInvoke).toHaveBeenCalledWith("ccswitch_status", {})
  })

  it("ccswitchListProviders invokes ccswitch_list_providers", async () => {
    mInvoke.mockResolvedValue([])
    await ccswitchListProviders()
    expect(mInvoke).toHaveBeenCalledWith("ccswitch_list_providers", {})
  })

  it("ccswitchListMcpServers invokes ccswitch_list_mcp_servers", async () => {
    mInvoke.mockResolvedValue([])
    await ccswitchListMcpServers()
    expect(mInvoke).toHaveBeenCalledWith("ccswitch_list_mcp_servers", {})
  })

  it("ccswitchListPrompts invokes ccswitch_list_prompts", async () => {
    mInvoke.mockResolvedValue([])
    await ccswitchListPrompts()
    expect(mInvoke).toHaveBeenCalledWith("ccswitch_list_prompts", {})
  })

  it("ccswitchListSkills invokes ccswitch_list_skills", async () => {
    mInvoke.mockResolvedValue([])
    await ccswitchListSkills()
    expect(mInvoke).toHaveBeenCalledWith("ccswitch_list_skills", {})
  })

  it("ccswitchWatchStart invokes ccswitch_watch_start", async () => {
    mInvoke.mockResolvedValue(true)
    const out = await ccswitchWatchStart()
    expect(mInvoke).toHaveBeenCalledWith("ccswitch_watch_start", {})
    expect(out).toBe(true)
  })

  it("ccswitchWatchStart threads a manual data dir", async () => {
    mInvoke.mockResolvedValue(true)
    await ccswitchWatchStart("~/cc-data")
    expect(mInvoke).toHaveBeenCalledWith("ccswitch_watch_start", { manualDataDir: "~/cc-data" })
  })

  it("ccswitchWatchStop invokes ccswitch_watch_stop", async () => {
    mInvoke.mockResolvedValue(undefined)
    await ccswitchWatchStop()
    expect(mInvoke).toHaveBeenCalledWith("ccswitch_watch_stop")
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

  it("writeGeminiSettingsEnv forwards the env-updates payload to write_gemini_settings_env", async () => {
    mInvoke.mockResolvedValue({ path: "/u/.gemini/settings.json" })
    const out = await writeGeminiSettingsEnv({
      GEMINI_API_KEY: "g-key",
      GOOGLE_GEMINI_BASE_URL: null,
    })
    expect(mInvoke).toHaveBeenCalledWith("write_gemini_settings_env", {
      envUpdates: { GEMINI_API_KEY: "g-key", GOOGLE_GEMINI_BASE_URL: null },
    })
    expect(out.path).toBe("/u/.gemini/settings.json")
  })

  it("writeOpencodeAuthEnv forwards the env-updates payload to write_opencode_auth_env", async () => {
    mInvoke.mockResolvedValue({ path: "/u/.local/share/opencode/auth.json" })
    const out = await writeOpencodeAuthEnv({
      OPENCODE_API_KEY: "sk-x",
      __provider: "anthropic",
    })
    expect(mInvoke).toHaveBeenCalledWith("write_opencode_auth_env", {
      envUpdates: { OPENCODE_API_KEY: "sk-x", __provider: "anthropic" },
    })
    expect(out.path).toBe("/u/.local/share/opencode/auth.json")
  })

  it("rejects every wrapper when not running in Tauri", async () => {
    mIsTauri.mockReturnValue(false)
    await expect(ccswitchStatus()).rejects.toThrow(/Tauri/)
    await expect(ccswitchListProviders()).rejects.toThrow(/Tauri/)
    await expect(ccswitchListMcpServers()).rejects.toThrow(/Tauri/)
    await expect(ccswitchListPrompts()).rejects.toThrow(/Tauri/)
    await expect(ccswitchListSkills()).rejects.toThrow(/Tauri/)
    await expect(ccswitchWatchStart()).rejects.toThrow(/Tauri/)
    await expect(ccswitchWatchStop()).rejects.toThrow(/Tauri/)
    await expect(writeClaudeSettingsEnv({})).rejects.toThrow(/Tauri/)
    await expect(writeCodexAuthEnv({})).rejects.toThrow(/Tauri/)
    await expect(writeGeminiSettingsEnv({})).rejects.toThrow(/Tauri/)
    await expect(writeOpencodeAuthEnv({})).rejects.toThrow(/Tauri/)
    expect(mInvoke).not.toHaveBeenCalled()
  })
})
