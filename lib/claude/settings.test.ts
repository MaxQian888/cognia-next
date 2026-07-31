import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

import {
  readClaudeEffectiveSettings,
  readClaudeLocalSettings,
  readClaudeProjectSettings,
  readClaudeUserSettings,
  subscribeClaudeSettings,
  writeClaudeLocalSettings,
  writeClaudeProjectSettings,
  writeClaudeUserSettings,
  type ClaudeSettings,
  type ClaudeSettingsChangedEvent,
  type EffectiveSettings,
} from "./settings"

jest.mock("@/lib/claude/hooks/lifecycle-firer", () => ({
  defaultLifecycleFirer: jest.fn(async () => null),
}))
import { defaultLifecycleFirer } from "@/lib/claude/hooks/lifecycle-firer"
const mockedFirer = defaultLifecycleFirer as unknown as jest.Mock

const mockedInvoke = invoke as unknown as jest.Mock
const mockedListen = listen as unknown as jest.Mock

beforeEach(() => {
  mockedInvoke.mockReset()
  mockedListen?.mockReset()
  mockedFirer.mockClear()
})

describe("readClaudeUserSettings", () => {
  it("delegates to the Tauri command and returns the response", async () => {
    const value: ClaudeSettings = { model: "claude-opus-4-7" }
    mockedInvoke.mockResolvedValueOnce(value)
    await expect(readClaudeUserSettings()).resolves.toEqual(value)
    expect(mockedInvoke).toHaveBeenCalledWith("read_claude_user_settings")
  })

  it("propagates a null response when the file is missing", async () => {
    mockedInvoke.mockResolvedValueOnce(null)
    await expect(readClaudeUserSettings()).resolves.toBeNull()
  })
})

describe("readClaudeProjectSettings / readClaudeLocalSettings", () => {
  it("forwards the cwd to the project-scope command", async () => {
    mockedInvoke.mockResolvedValueOnce(null)
    await readClaudeProjectSettings("/work/proj")
    expect(mockedInvoke).toHaveBeenCalledWith("read_claude_project_settings", {
      cwd: "/work/proj",
    })
  })

  it("forwards the cwd to the local-scope command", async () => {
    mockedInvoke.mockResolvedValueOnce(null)
    await readClaudeLocalSettings("/work/proj")
    expect(mockedInvoke).toHaveBeenCalledWith("read_claude_local_settings", {
      cwd: "/work/proj",
    })
  })
})

describe("readClaudeEffectiveSettings", () => {
  const eff: EffectiveSettings = {
    user: { model: "user-model" },
    project: null,
    local: null,
    merged: { model: "user-model" },
  }

  it("forwards an explicit cwd verbatim", async () => {
    mockedInvoke.mockResolvedValueOnce(eff)
    await expect(readClaudeEffectiveSettings("/x")).resolves.toEqual(eff)
    expect(mockedInvoke).toHaveBeenCalledWith("read_claude_effective_settings", {
      cwd: "/x",
    })
  })

  it("substitutes null when cwd is omitted", async () => {
    mockedInvoke.mockResolvedValueOnce(eff)
    await readClaudeEffectiveSettings()
    expect(mockedInvoke).toHaveBeenCalledWith("read_claude_effective_settings", {
      cwd: null,
    })
  })

  it("substitutes null for an explicit null cwd", async () => {
    mockedInvoke.mockResolvedValueOnce(eff)
    await readClaudeEffectiveSettings(null)
    expect(mockedInvoke).toHaveBeenCalledWith("read_claude_effective_settings", {
      cwd: null,
    })
  })
})

describe("writeClaudeUserSettings (Phase 4 writer)", () => {
  it("forwards the payload object verbatim", async () => {
    const payload: ClaudeSettings = { model: "haiku", hooks: { PreToolUse: [] } }
    mockedInvoke.mockResolvedValueOnce({
      path: "/home/u/.claude/settings.json",
      backupPath: null,
    })
    const result = await writeClaudeUserSettings(payload)
    expect(mockedInvoke).toHaveBeenCalledWith("write_claude_user_settings", { payload })
    expect(result.path).toBe("/home/u/.claude/settings.json")
  })

  it("propagates Rust-side errors", async () => {
    mockedInvoke.mockRejectedValueOnce("not installed")
    await expect(writeClaudeUserSettings({})).rejects.toEqual("not installed")
  })

  it("fires the ConfigChange lifecycle hook after a successful write", async () => {
    mockedInvoke.mockResolvedValueOnce({ path: "/p", backupPath: null })
    await writeClaudeUserSettings({ model: "x" })
    expect(mockedFirer).toHaveBeenCalledWith(
      "ConfigChange",
      expect.objectContaining({ sessionId: "user" }),
      expect.objectContaining({ payload: { scope: "user" } })
    )
  })

  it("does NOT fire ConfigChange when the write fails", async () => {
    mockedInvoke.mockRejectedValueOnce("boom")
    await expect(writeClaudeUserSettings({})).rejects.toEqual("boom")
    expect(mockedFirer).not.toHaveBeenCalled()
  })
})

describe("writeClaudeProjectSettings + writeClaudeLocalSettings", () => {
  it("project writer forwards cwd + payload", async () => {
    mockedInvoke.mockResolvedValueOnce({ path: "/repo/.claude/settings.json", backupPath: null })
    await writeClaudeProjectSettings("/repo", { model: "x" })
    expect(mockedInvoke).toHaveBeenCalledWith("write_claude_project_settings", {
      cwd: "/repo",
      payload: { model: "x" },
    })
  })

  it("local writer targets settings.local.json", async () => {
    mockedInvoke.mockResolvedValueOnce({
      path: "/repo/.claude/settings.local.json",
      backupPath: null,
    })
    await writeClaudeLocalSettings("/repo", {})
    expect(mockedInvoke).toHaveBeenCalledWith("write_claude_local_settings", {
      cwd: "/repo",
      payload: {},
    })
  })
})

describe("subscribeClaudeSettings", () => {
  it("registers a Tauri listener and unwraps the payload before handing to the caller", async () => {
    const handler = jest.fn()
    let captured: ((e: { payload: unknown }) => void) | undefined
    mockedListen.mockImplementationOnce((_name: string, fn: (e: { payload: unknown }) => void) => {
      captured = fn
      return Promise.resolve(() => undefined)
    })
    await subscribeClaudeSettings(handler)
    expect(mockedListen).toHaveBeenCalledWith("claude-settings-changed", expect.any(Function))
    const evt: ClaudeSettingsChangedEvent = { scope: "user", path: "/u/.claude/settings.json" }
    captured?.({ payload: evt })
    expect(handler).toHaveBeenCalledWith(evt)
  })
})
