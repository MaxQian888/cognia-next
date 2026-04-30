import { invoke } from "@tauri-apps/api/core"

import {
  readClaudeEffectiveSettings,
  readClaudeLocalSettings,
  readClaudeProjectSettings,
  readClaudeUserSettings,
  type ClaudeSettings,
  type EffectiveSettings,
} from "./settings"

const mockedInvoke = invoke as unknown as jest.Mock

beforeEach(() => {
  mockedInvoke.mockReset()
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
