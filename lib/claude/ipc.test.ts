import { invoke } from "@tauri-apps/api/core"

jest.mock("@tauri-apps/api/event", () => ({
  listen: jest.fn(),
}))

import { listen } from "@tauri-apps/api/event"

import {
  approveTool,
  closeSession,
  defaultExportDir,
  ensureDir,
  getSidecarStatus,
  hasApiKey,
  interruptSession,
  onClaudeMessage,
  readAgentConfig,
  readClaudeUserConfig,
  readTextFile,
  restartSidecar,
  scanClaudeSkills,
  sendPrompt,
  setApiKey,
  skillsFetchRemoteMd,
  skillsInstallNative,
  skillsLoadRegistry,
  skillsScanDir,
  skillsScanNative,
  skillsScanResources,
  skillsScanSecurity,
  skillsUninstallNative,
  testMcpServer,
  writeAgentConfig,
  writeTextFile,
} from "./ipc"

const TAURI_KEY = "__TAURI_INTERNALS__"

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

const mockedInvoke = invoke as unknown as jest.Mock
const mockedListen = listen as unknown as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  setTauri(true)
})

afterEach(() => {
  setTauri(false)
})

describe("ensureTauri guard", () => {
  it("every wrapper throws a clear error when not running inside Tauri", async () => {
    setTauri(false)
    const matcher = /Claude IPC is only available inside Tauri/

    await expect(sendPrompt("s", "hi")).rejects.toThrow(matcher)
    await expect(interruptSession("s")).rejects.toThrow(matcher)
    await expect(approveTool("s", "r", "allow")).rejects.toThrow(matcher)
    await expect(closeSession("s")).rejects.toThrow(matcher)
    await expect(getSidecarStatus()).rejects.toThrow(matcher)
    await expect(setApiKey(null)).rejects.toThrow(matcher)
    await expect(hasApiKey()).rejects.toThrow(matcher)
    await expect(restartSidecar()).rejects.toThrow(matcher)
    expect(() => onClaudeMessage(() => undefined)).toThrow(matcher)
    await expect(readTextFile("/x")).rejects.toThrow(matcher)
    await expect(writeTextFile("/x", "y")).rejects.toThrow(matcher)
    await expect(ensureDir("/x")).rejects.toThrow(matcher)
    await expect(defaultExportDir()).rejects.toThrow(matcher)
    await expect(scanClaudeSkills()).rejects.toThrow(matcher)
    await expect(readClaudeUserConfig()).rejects.toThrow(matcher)
    await expect(readAgentConfig("claude-code")).rejects.toThrow(matcher)
    await expect(writeAgentConfig("claude-code", {})).rejects.toThrow(matcher)
    await expect(skillsScanNative()).rejects.toThrow(matcher)
    await expect(skillsScanDir("/x")).rejects.toThrow(matcher)
    await expect(
      skillsInstallNative({ dirName: "x", content: "", resources: [], clean: false })
    ).rejects.toThrow(matcher)
    await expect(skillsUninstallNative("x")).rejects.toThrow(matcher)
    await expect(skillsFetchRemoteMd("https://x")).rejects.toThrow(matcher)
    await expect(skillsLoadRegistry()).rejects.toThrow(matcher)
    await expect(skillsScanSecurity("body")).rejects.toThrow(matcher)
    await expect(skillsScanResources([["x", "y"]])).rejects.toThrow(matcher)
    await expect(testMcpServer({ transport: "stdio", command: "x" })).rejects.toThrow(matcher)
  })
})

describe("Claude session commands", () => {
  it("sendPrompt forwards sessionId / prompt / options", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    await sendPrompt("sess-1", "hello", { model: "claude-opus-4-7" })
    expect(mockedInvoke).toHaveBeenCalledWith("claude_send", {
      sessionId: "sess-1",
      prompt: "hello",
      options: { model: "claude-opus-4-7" },
    })
  })

  it("sendPrompt accepts undefined options", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    await sendPrompt("sess-1", "hi")
    expect(mockedInvoke).toHaveBeenCalledWith("claude_send", {
      sessionId: "sess-1",
      prompt: "hi",
      options: undefined,
    })
  })

  it("interruptSession invokes the interrupt command with the id", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    await interruptSession("sess-2")
    expect(mockedInvoke).toHaveBeenCalledWith("claude_interrupt", { sessionId: "sess-2" })
  })

  it("approveTool packs the decision payload", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    await approveTool("sess-3", "req-1", "deny", "no thanks", { foo: 1 })
    expect(mockedInvoke).toHaveBeenCalledWith("claude_approve", {
      sessionId: "sess-3",
      requestId: "req-1",
      decision: "deny",
      message: "no thanks",
      updatedInput: { foo: 1 },
    })
  })

  it("approveTool tolerates omitted message / updatedInput", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    await approveTool("sess-3", "req-1", "allow")
    expect(mockedInvoke).toHaveBeenCalledWith("claude_approve", {
      sessionId: "sess-3",
      requestId: "req-1",
      decision: "allow",
      message: undefined,
      updatedInput: undefined,
    })
  })

  it("closeSession invokes the close command", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    await closeSession("sess-4")
    expect(mockedInvoke).toHaveBeenCalledWith("claude_close_session", { sessionId: "sess-4" })
  })

  it("getSidecarStatus returns the parsed boolean", async () => {
    mockedInvoke.mockResolvedValueOnce({ ready: true })
    await expect(getSidecarStatus()).resolves.toEqual({ ready: true })
  })

  it("setApiKey forwards the key (string or null)", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    await setApiKey("sk-abc")
    expect(mockedInvoke).toHaveBeenCalledWith("claude_set_api_key", { key: "sk-abc" })

    mockedInvoke.mockResolvedValueOnce(undefined)
    await setApiKey(null)
    expect(mockedInvoke).toHaveBeenCalledWith("claude_set_api_key", { key: null })
  })

  it("hasApiKey returns the boolean from the command", async () => {
    mockedInvoke.mockResolvedValueOnce(true)
    await expect(hasApiKey()).resolves.toBe(true)
    expect(mockedInvoke).toHaveBeenCalledWith("claude_has_api_key")
  })

  it("restartSidecar invokes its command", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    await restartSidecar()
    expect(mockedInvoke).toHaveBeenCalledWith("claude_restart_sidecar")
  })
})

describe("onClaudeMessage", () => {
  it("subscribes to the sidecar event channel and forwards payloads", async () => {
    const unlistenSpy = jest.fn()
    let captured: ((event: { payload: unknown }) => void) | undefined

    mockedListen.mockImplementation(((
      channel: string,
      handler: (e: { payload: unknown }) => void
    ) => {
      expect(channel).toBe("claude://message")
      captured = handler
      return Promise.resolve(unlistenSpy)
    }) as unknown as typeof listen)

    const handler = jest.fn()
    const unlisten = await onClaudeMessage(handler)

    expect(captured).toBeDefined()
    captured?.({ payload: { type: "ready" } })
    expect(handler).toHaveBeenCalledWith({ type: "ready" })

    expect(unlisten).toBe(unlistenSpy)
  })
})

describe("filesystem commands", () => {
  it("readTextFile returns the string content", async () => {
    mockedInvoke.mockResolvedValueOnce("file body")
    await expect(readTextFile("/p")).resolves.toBe("file body")
    expect(mockedInvoke).toHaveBeenCalledWith("read_text_file", { path: "/p" })
  })

  it("writeTextFile forwards path + content", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    await writeTextFile("/p", "data")
    expect(mockedInvoke).toHaveBeenCalledWith("write_text_file", {
      path: "/p",
      content: "data",
    })
  })

  it("ensureDir forwards the path", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    await ensureDir("/p")
    expect(mockedInvoke).toHaveBeenCalledWith("ensure_dir", { path: "/p" })
  })

  it("defaultExportDir returns the resolved path", async () => {
    mockedInvoke.mockResolvedValueOnce("/exports")
    await expect(defaultExportDir()).resolves.toBe("/exports")
    expect(mockedInvoke).toHaveBeenCalledWith("default_export_dir")
  })
})

describe("scanClaudeSkills", () => {
  it("camelCases each row's snake_case fields", async () => {
    mockedInvoke.mockResolvedValueOnce([
      { dir_name: "skill-a", file_path: "/p/a.md", content: "a body" },
      { dir_name: "skill-b", file_path: "/p/b.md", content: "b body" },
    ])
    const out = await scanClaudeSkills()
    expect(out).toEqual([
      { dirName: "skill-a", filePath: "/p/a.md", content: "a body" },
      { dirName: "skill-b", filePath: "/p/b.md", content: "b body" },
    ])
  })
})

describe("readClaudeUserConfig", () => {
  it("returns the parsed JSON tree as-is", async () => {
    mockedInvoke.mockResolvedValueOnce({ model: "x" })
    await expect(readClaudeUserConfig()).resolves.toEqual({ model: "x" })
    expect(mockedInvoke).toHaveBeenCalledWith("read_claude_user_config")
  })
})

describe("multi-agent MCP IO", () => {
  it("readAgentConfig forwards the agent id and returns the result", async () => {
    const result = {
      path: "/x",
      exists: true,
      writable: true,
      format: "json" as const,
      raw: "{}",
      parsed: {},
    }
    mockedInvoke.mockResolvedValueOnce(result)
    await expect(readAgentConfig("cursor")).resolves.toEqual(result)
    expect(mockedInvoke).toHaveBeenCalledWith("read_agent_config", { agent: "cursor" })
  })

  it("writeAgentConfig forwards the agent id and value tree", async () => {
    mockedInvoke.mockResolvedValueOnce({ path: "/x", backupPath: "/x.bak" })
    const out = await writeAgentConfig("cursor", { mcpServers: { a: { command: "a" } } })
    expect(out).toEqual({ path: "/x", backupPath: "/x.bak" })
    expect(mockedInvoke).toHaveBeenCalledWith("write_agent_config", {
      agent: "cursor",
      value: { mcpServers: { a: { command: "a" } } },
    })
  })
})

describe("skills commands", () => {
  it("skillsScanNative just forwards the response", async () => {
    mockedInvoke.mockResolvedValueOnce([
      { dirName: "x", filePath: "/x", content: "", resources: [] },
    ])
    await expect(skillsScanNative()).resolves.toHaveLength(1)
    expect(mockedInvoke).toHaveBeenCalledWith("skills_scan_native")
  })

  it("skillsScanDir forwards the path argument", async () => {
    mockedInvoke.mockResolvedValueOnce([])
    await skillsScanDir("/scan/me")
    expect(mockedInvoke).toHaveBeenCalledWith("skills_scan_dir", { path: "/scan/me" })
  })

  it("skillsInstallNative wraps the request in {request}", async () => {
    mockedInvoke.mockResolvedValueOnce({ directory: "/d", writtenFiles: ["a"] })
    const req = { dirName: "x", content: "y", resources: [], clean: false }
    await skillsInstallNative(req)
    expect(mockedInvoke).toHaveBeenCalledWith("skills_install_native", { request: req })
  })

  it("skillsUninstallNative forwards dirName", async () => {
    mockedInvoke.mockResolvedValueOnce({ removed: true, directory: "/d" })
    await skillsUninstallNative("x")
    expect(mockedInvoke).toHaveBeenCalledWith("skills_uninstall_native", { dirName: "x" })
  })

  it("skillsFetchRemoteMd forwards url", async () => {
    mockedInvoke.mockResolvedValueOnce("# md")
    await expect(skillsFetchRemoteMd("https://e/x.md")).resolves.toBe("# md")
    expect(mockedInvoke).toHaveBeenCalledWith("skills_fetch_remote_md", {
      url: "https://e/x.md",
    })
  })

  it("skillsLoadRegistry just returns the array", async () => {
    mockedInvoke.mockResolvedValueOnce([{ id: "x", source: "y", sourceType: "z" }])
    await expect(skillsLoadRegistry()).resolves.toHaveLength(1)
  })

  it("skillsScanSecurity forwards content", async () => {
    mockedInvoke.mockResolvedValueOnce([])
    await skillsScanSecurity("body")
    expect(mockedInvoke).toHaveBeenCalledWith("skills_scan_security", { content: "body" })
  })

  it("skillsScanResources forwards the [path,content] tuples", async () => {
    mockedInvoke.mockResolvedValueOnce([])
    await skillsScanResources([
      ["/a", "alpha"],
      ["/b", "beta"],
    ])
    expect(mockedInvoke).toHaveBeenCalledWith("skills_scan_resources", {
      resources: [
        ["/a", "alpha"],
        ["/b", "beta"],
      ],
    })
  })
})

describe("testMcpServer", () => {
  it("normalizes snake_case Rust output and undefineds nullable fields", async () => {
    mockedInvoke.mockResolvedValueOnce({
      ok: true,
      tool_count: 2,
      tools: [
        { name: "echo", description: "say it back" },
        { name: "noop", description: null },
      ],
      error: null,
      duration_ms: 42,
    })
    const out = await testMcpServer({ transport: "stdio", command: "x", args: ["y"] })
    expect(out).toEqual({
      ok: true,
      toolCount: 2,
      tools: [
        { name: "echo", description: "say it back" },
        { name: "noop", description: undefined },
      ],
      error: undefined,
      durationMs: 42,
    })
    // Spread into the payload preserves shape.
    expect(mockedInvoke).toHaveBeenCalledWith("test_mcp_server", {
      transport: "stdio",
      command: "x",
      args: ["y"],
    })
  })

  it("propagates an error string and a zero tool count", async () => {
    mockedInvoke.mockResolvedValueOnce({
      ok: false,
      tool_count: 0,
      tools: [],
      error: "spawn failed",
      duration_ms: 100,
    })
    const out = await testMcpServer({ transport: "stdio", command: "x" })
    expect(out.ok).toBe(false)
    expect(out.error).toBe("spawn failed")
    expect(out.toolCount).toBe(0)
    expect(out.tools).toEqual([])
  })
})
