import { transport } from "@/lib/tauri"

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

const mockedListen = listen as unknown as jest.Mock

let callSpy: jest.SpiedFunction<typeof transport.call>

beforeEach(() => {
  jest.clearAllMocks()
  setTauri(true)
  callSpy = jest.spyOn(transport, "call")
})

afterEach(() => {
  setTauri(false)
  jest.restoreAllMocks()
})

describe("web-mode rejection", () => {
  it("transport-routed wrappers reject with the WebStub error when no spy is attached", async () => {
    setTauri(false)
    callSpy.mockRestore()

    await expect(sendPrompt("s", "hi")).rejects.toThrow(/tauri-only command from web mode/)
    await expect(getSidecarStatus()).rejects.toThrow(/tauri-only command from web mode/)
    await expect(setApiKey(null)).rejects.toThrow(/tauri-only command from web mode/)
  })

  it("onClaudeMessage in web mode resolves to a no-op unlistener (M1.5 transport.subscribe contract)", async () => {
    setTauri(false)
    callSpy.mockRestore()
    // No spy on transport.subscribe — falls through to WebStubTransport.subscribe
    // which returns a no-op unlistener and never calls the handler.
    const handler = jest.fn()
    const unlisten = await onClaudeMessage(handler)
    expect(typeof unlisten).toBe("function")
    expect(handler).not.toHaveBeenCalled()
  })
})

describe("Claude session commands", () => {
  it("sendPrompt forwards sessionId / prompt / options", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    await sendPrompt("sess-1", "hello", { model: "claude-opus-4-7" })
    expect(callSpy).toHaveBeenCalledWith("claude_send", {
      sessionId: "sess-1",
      prompt: "hello",
      options: { model: "claude-opus-4-7" },
    })
  })

  it("sendPrompt accepts undefined options", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    await sendPrompt("sess-1", "hi")
    expect(callSpy).toHaveBeenCalledWith("claude_send", {
      sessionId: "sess-1",
      prompt: "hi",
      options: undefined,
    })
  })

  it("interruptSession invokes the interrupt command with the id", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    await interruptSession("sess-2")
    expect(callSpy).toHaveBeenCalledWith("claude_interrupt", { sessionId: "sess-2" })
  })

  it("approveTool packs the decision payload", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    await approveTool("sess-3", "req-1", "deny", "no thanks", { foo: 1 })
    expect(callSpy).toHaveBeenCalledWith("claude_approve", {
      sessionId: "sess-3",
      requestId: "req-1",
      decision: "deny",
      message: "no thanks",
      updatedInput: { foo: 1 },
    })
  })

  it("approveTool tolerates omitted message / updatedInput", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    await approveTool("sess-3", "req-1", "allow")
    expect(callSpy).toHaveBeenCalledWith("claude_approve", {
      sessionId: "sess-3",
      requestId: "req-1",
      decision: "allow",
      message: undefined,
      updatedInput: undefined,
    })
  })

  it("closeSession invokes the close command", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    await closeSession("sess-4")
    expect(callSpy).toHaveBeenCalledWith("claude_close_session", { sessionId: "sess-4" })
  })

  it("getSidecarStatus returns the parsed boolean", async () => {
    callSpy.mockResolvedValueOnce({ ready: true })
    await expect(getSidecarStatus()).resolves.toEqual({ ready: true })
  })

  it("setApiKey forwards the key (string or null)", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    await setApiKey("sk-abc")
    expect(callSpy).toHaveBeenCalledWith("claude_set_api_key", { key: "sk-abc" })

    callSpy.mockResolvedValueOnce(undefined)
    await setApiKey(null)
    expect(callSpy).toHaveBeenCalledWith("claude_set_api_key", { key: null })
  })

  it("hasApiKey returns the boolean from the command", async () => {
    callSpy.mockResolvedValueOnce(true)
    await expect(hasApiKey()).resolves.toBe(true)
    expect(callSpy).toHaveBeenCalledWith("claude_has_api_key")
  })

  it("restartSidecar invokes its command", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    await restartSidecar()
    expect(callSpy).toHaveBeenCalledWith("claude_restart_sidecar")
  })
})

describe("onClaudeMessage", () => {
  it("subscribes via transport.subscribe with the channel + caller handler", async () => {
    const unlistenSpy = jest.fn()
    let captured: ((payload: unknown) => void) | undefined
    const subscribeSpy = jest.spyOn(transport, "subscribe").mockImplementation((channel, h) => {
      expect(channel).toBe("claude://message")
      captured = h as (payload: unknown) => void
      return unlistenSpy
    })

    const handler = jest.fn()
    const unlisten = await onClaudeMessage(handler)

    expect(subscribeSpy).toHaveBeenCalledWith("claude://message", handler)
    expect(captured).toBeDefined()
    captured?.({ type: "ready" })
    expect(handler).toHaveBeenCalledWith({ type: "ready" })
    expect(unlisten).toBe(unlistenSpy)
  })
})

describe("filesystem commands", () => {
  it("readTextFile returns the string content", async () => {
    callSpy.mockResolvedValueOnce("file body")
    await expect(readTextFile("/p")).resolves.toBe("file body")
    expect(callSpy).toHaveBeenCalledWith("read_text_file", { path: "/p" })
  })

  it("writeTextFile forwards path + content", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    await writeTextFile("/p", "data")
    expect(callSpy).toHaveBeenCalledWith("write_text_file", {
      path: "/p",
      content: "data",
    })
  })

  it("ensureDir forwards the path", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    await ensureDir("/p")
    expect(callSpy).toHaveBeenCalledWith("ensure_dir", { path: "/p" })
  })

  it("defaultExportDir returns the resolved path", async () => {
    callSpy.mockResolvedValueOnce("/exports")
    await expect(defaultExportDir()).resolves.toBe("/exports")
    expect(callSpy).toHaveBeenCalledWith("default_export_dir")
  })
})

describe("scanClaudeSkills", () => {
  it("camelCases each row's snake_case fields", async () => {
    callSpy.mockResolvedValueOnce([
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
    callSpy.mockResolvedValueOnce({ model: "x" })
    await expect(readClaudeUserConfig()).resolves.toEqual({ model: "x" })
    expect(callSpy).toHaveBeenCalledWith("read_claude_user_config")
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
    callSpy.mockResolvedValueOnce(result)
    await expect(readAgentConfig("cursor")).resolves.toEqual(result)
    expect(callSpy).toHaveBeenCalledWith("read_agent_config", { agent: "cursor" })
  })

  it("writeAgentConfig forwards the agent id and value tree", async () => {
    callSpy.mockResolvedValueOnce({ path: "/x", backupPath: "/x.bak" })
    const out = await writeAgentConfig("cursor", { mcpServers: { a: { command: "a" } } })
    expect(out).toEqual({ path: "/x", backupPath: "/x.bak" })
    expect(callSpy).toHaveBeenCalledWith("write_agent_config", {
      agent: "cursor",
      value: { mcpServers: { a: { command: "a" } } },
    })
  })
})

describe("skills commands", () => {
  it("skillsScanNative just forwards the response", async () => {
    callSpy.mockResolvedValueOnce([{ dirName: "x", filePath: "/x", content: "", resources: [] }])
    await expect(skillsScanNative()).resolves.toHaveLength(1)
    expect(callSpy).toHaveBeenCalledWith("skills_scan_native")
  })

  it("skillsScanDir forwards the path argument", async () => {
    callSpy.mockResolvedValueOnce([])
    await skillsScanDir("/scan/me")
    expect(callSpy).toHaveBeenCalledWith("skills_scan_dir", { path: "/scan/me" })
  })

  it("skillsInstallNative wraps the request in {request}", async () => {
    callSpy.mockResolvedValueOnce({ directory: "/d", writtenFiles: ["a"] })
    const req = { dirName: "x", content: "y", resources: [], clean: false }
    await skillsInstallNative(req)
    expect(callSpy).toHaveBeenCalledWith("skills_install_native", { request: req })
  })

  it("skillsUninstallNative forwards dirName", async () => {
    callSpy.mockResolvedValueOnce({ removed: true, directory: "/d" })
    await skillsUninstallNative("x")
    expect(callSpy).toHaveBeenCalledWith("skills_uninstall_native", { dirName: "x" })
  })

  it("skillsFetchRemoteMd forwards url", async () => {
    callSpy.mockResolvedValueOnce("# md")
    await expect(skillsFetchRemoteMd("https://e/x.md")).resolves.toBe("# md")
    expect(callSpy).toHaveBeenCalledWith("skills_fetch_remote_md", {
      url: "https://e/x.md",
    })
  })

  it("skillsLoadRegistry just returns the array", async () => {
    callSpy.mockResolvedValueOnce([{ id: "x", source: "y", sourceType: "z" }])
    await expect(skillsLoadRegistry()).resolves.toHaveLength(1)
  })

  it("skillsScanSecurity forwards content", async () => {
    callSpy.mockResolvedValueOnce([])
    await skillsScanSecurity("body")
    expect(callSpy).toHaveBeenCalledWith("skills_scan_security", { content: "body" })
  })

  it("skillsScanResources forwards the [path,content] tuples", async () => {
    callSpy.mockResolvedValueOnce([])
    await skillsScanResources([
      ["/a", "alpha"],
      ["/b", "beta"],
    ])
    expect(callSpy).toHaveBeenCalledWith("skills_scan_resources", {
      resources: [
        ["/a", "alpha"],
        ["/b", "beta"],
      ],
    })
  })
})

describe("testMcpServer", () => {
  it("normalizes snake_case Rust output and undefineds nullable fields", async () => {
    callSpy.mockResolvedValueOnce({
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
    expect(callSpy).toHaveBeenCalledWith("test_mcp_server", {
      transport: "stdio",
      command: "x",
      args: ["y"],
    })
  })

  it("propagates an error string and a zero tool count", async () => {
    callSpy.mockResolvedValueOnce({
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
