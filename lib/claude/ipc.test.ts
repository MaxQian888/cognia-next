/** @jest-environment jsdom */
import { transport } from "@/lib/tauri"

const mockHasNoLeakingPiiDeep = jest.fn((..._args: unknown[]) => true)
jest.mock("@cognia/redact", () => ({
  hasNoLeakingPiiDeep: (...args: unknown[]) => mockHasNoLeakingPiiDeep(...args),
}))

jest.mock("@tauri-apps/api/event", () => ({
  listen: jest.fn(),
}))

import { listen } from "@tauri-apps/api/event"

import {
  approveTool,
  closeSession,
  defaultExportDir,
  deleteMessage,
  ensureDir,
  compactSession,
  getSidecarStatus,
  hasApiKey,
  interruptSession,
  listSessions,
  onClaudeMessage,
  readAgentConfig,
  readClaudeUserConfig,
  readTextFile,
  restartSidecar,
  restoreSession,
  scanClaudeSkills,
  sendPluginToolResponse,
  sendPrompt,
  sessionControl,
  steerSession,
  subscribePluginToolExec,
  setApiKey,
  skillsBundleUploadAbort,
  skillsBundleUploadCommit,
  skillsBundleUploadOpen,
  skillsBundleUploadWrite,
  skillsCatalogGet,
  skillsFetchRemoteJson,
  skillsFetchRemoteMd,
  skillsInstallAtomic,
  skillsInstallNative,
  skillsLoadRegistry,
  skillsScanDir,
  skillsScanNative,
  skillsScanResources,
  skillsScanSecurity,
  skillsUninstallNative,
  skillsUninstall,
  testMcpServer,
  updateMessage,
  writeAgentConfig,
  writeTextFile,
  writeTextFileConfined,
  ensureDirConfined,
} from "./ipc"

const TAURI_KEY = "__TAURI_INTERNALS__"

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

const _mockedListen = listen as unknown as jest.Mock

let callSpy: jest.SpiedFunction<typeof transport.call>

beforeEach(() => {
  jest.clearAllMocks()
  mockHasNoLeakingPiiDeep.mockReturnValue(true)
  setTauri(true)
  callSpy = jest.spyOn(transport, "call")
})

afterEach(() => {
  setTauri(false)
  jest.restoreAllMocks()
})

describe("subscribePluginToolExec", () => {
  it("forwards only plugin_tool_exec events to the handler", async () => {
    let captured: ((evt: unknown) => void) | null = null
    const sub = jest
      .spyOn(transport, "subscribe")
      .mockImplementation((_ch: string, h: (evt: unknown) => void) => {
        captured = h
        return () => {}
      })
    const handler = jest.fn()
    await subscribePluginToolExec(handler)
    expect(sub).toHaveBeenCalled()
    captured!({ type: "plugin_tool_exec", sessionId: "s", toolUseId: "t", name: "n", args: {} })
    captured!({ type: "ready" })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: "plugin_tool_exec", toolUseId: "t" })
    )
  })
})

describe("sendPluginToolResponse", () => {
  it("invokes claude_plugin_tool_response with the response payload", async () => {
    callSpy.mockResolvedValue(undefined)
    await sendPluginToolResponse({
      type: "plugin_tool_response",
      sessionId: "s1",
      toolUseId: "t1",
      result: "ok",
    })
    expect(callSpy).toHaveBeenCalledWith("claude_plugin_tool_response", {
      sessionId: "s1",
      toolUseId: "t1",
      result: "ok",
      error: undefined,
    })
  })

  it("forwards the server-issued remote execution context unchanged", async () => {
    const context = {
      hostId: "host-a",
      originDeviceId: "device-a",
      sessionId: "s1",
      generation: 1,
      requestId: "request-a",
      issuedAt: 1,
      expiresAt: 2,
    }
    callSpy.mockResolvedValue(undefined)
    await sendPluginToolResponse(
      {
        type: "plugin_tool_response",
        sessionId: "s1",
        toolUseId: "t1",
        result: "ok",
      },
      context
    )
    expect(callSpy).toHaveBeenCalledWith(
      "claude_plugin_tool_response",
      expect.objectContaining({ remoteExecutionContext: context })
    )
  })
})

describe("steerSession", () => {
  it("uses the correlated session-control channel and requests immediate queued input", async () => {
    let emit: ((event: unknown) => void) | undefined
    jest.spyOn(transport, "subscribe").mockImplementation((_channel, handler) => {
      emit = handler
      return () => undefined
    })
    callSpy.mockImplementation(async (_command, payload) => {
      const request = payload as { requestId: string }
      queueMicrotask(() => {
        emit?.({
          type: "control_response",
          sessionId: "session-1",
          requestId: request.requestId,
          method: "steer",
          ok: true,
          result: { accepted: true },
        })
      })
      return undefined
    })

    await expect(steerSession("session-1", "change direction", "om-steer")).resolves.toEqual({
      accepted: true,
    })
    expect(callSpy).toHaveBeenCalledWith(
      "claude_session_control",
      expect.objectContaining({
        sessionId: "session-1",
        method: "steer",
        params: { prompt: "change direction", priority: "now", sourceMessageId: "om-steer" },
      })
    )
  })

  it("fails closed before transport and cannot be bypassed through generic controls", async () => {
    mockHasNoLeakingPiiDeep.mockReturnValue(false)
    await expect(steerSession("session-1", "user@example.com")).rejects.toThrow(/renderer PII gate/)
    await expect(
      sessionControl("session-1", "steer" as never, { prompt: "user@example.com" })
    ).rejects.toThrow(/PII-gated steerSession/)
    expect(callSpy).not.toHaveBeenCalled()
  })
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
  it("gates the complete provider-visible prompt before any send", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    await sendPrompt("sess-1", "hello", {
      systemPrompt: "system",
      appendSystemPrompt: "append",
    })

    expect(mockHasNoLeakingPiiDeep).toHaveBeenCalledWith({
      prompt: "hello",
      systemPrompt: "system",
      appendSystemPrompt: "append",
    })

    mockHasNoLeakingPiiDeep.mockReturnValue(false)
    await expect(sendPrompt("sess-1", "secret")).rejects.toThrow(
      "prompt rejected by the renderer PII gate"
    )
    expect(callSpy).toHaveBeenCalledTimes(1)
  })

  it("gates provider-visible Agent SDK options before transport", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    await sendPrompt("sess-1", "hello", {
      claudeAgentSdk: {
        version: 1,
        planModeInstructions: "review carefully",
        toolAliases: { Read: "Inspect file" },
      },
    })

    expect(mockHasNoLeakingPiiDeep).toHaveBeenCalledWith(
      expect.objectContaining({
        claudeAgentSdk: expect.objectContaining({
          planModeInstructions: "review carefully",
          toolAliases: { Read: "Inspect file" },
        }),
      })
    )

    mockHasNoLeakingPiiDeep.mockReturnValue(false)
    await expect(
      sendPrompt("sess-1", "hello", {
        agents: { reviewer: { description: "private agent", prompt: "secret" } },
      })
    ).rejects.toThrow("prompt rejected by the renderer PII gate")
    expect(callSpy).toHaveBeenCalledTimes(1)
  })

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

  it("compactSession forwards the session id and optional focus", async () => {
    callSpy.mockResolvedValue(undefined)
    await compactSession("sess-3")
    expect(callSpy).toHaveBeenCalledWith("claude_compact", {
      sessionId: "sess-3",
      focus: undefined,
    })
    await compactSession("sess-3", "the API changes")
    expect(callSpy).toHaveBeenCalledWith("claude_compact", {
      sessionId: "sess-3",
      focus: "the API changes",
    })
  })

  it("gates restored conversation snapshots before transport", async () => {
    callSpy.mockResolvedValue(undefined)
    const messages = [{ role: "user", content: "safe context" }]
    await restoreSession("sess-3", messages)
    expect(mockHasNoLeakingPiiDeep).toHaveBeenCalledWith(messages)
    expect(callSpy).toHaveBeenCalledWith("claude_restore", {
      sessionId: "sess-3",
      messages,
    })

    mockHasNoLeakingPiiDeep.mockReturnValue(false)
    await expect(
      restoreSession("sess-3", [{ role: "user", content: "user@example.com" }])
    ).rejects.toThrow(/renderer PII gate/)
    expect(callSpy).toHaveBeenCalledTimes(1)
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

    expect(subscribeSpy).toHaveBeenCalledWith("claude://message", expect.any(Function))
    expect(captured).toBeDefined()
    captured?.({ type: "ready" })
    expect(handler).toHaveBeenCalledWith({ type: "ready" })
    expect(unlisten).toBe(unlistenSpy)
  })

  it("binds an approval response to the context carried by its request event", async () => {
    let captured: ((event: never) => void) | undefined
    jest.spyOn(transport, "subscribe").mockImplementation((_channel, handler) => {
      captured = handler
      return () => undefined
    })
    const context = {
      hostId: "host-a",
      originDeviceId: "device-a",
      sessionId: "session-a",
      generation: 1,
      requestId: "turn-a",
      issuedAt: 1,
      expiresAt: 2,
    }
    await onClaudeMessage(jest.fn())
    captured?.({
      type: "permission_request",
      sessionId: "session-a",
      requestId: "approval-a",
      remoteExecutionContext: context,
    } as never)
    callSpy.mockResolvedValue(undefined)

    await approveTool("session-a", "approval-a", "allow")

    expect(callSpy).toHaveBeenCalledWith(
      "claude_approve",
      expect.objectContaining({ remoteExecutionContext: context })
    )
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

  it("writeTextFileConfined forwards path, content, and allowed roots", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    await writeTextFileConfined("/w/a.txt", "data", ["/w"])
    expect(callSpy).toHaveBeenCalledWith("write_text_file_confined", {
      path: "/w/a.txt",
      content: "data",
      allowedRoots: ["/w"],
    })
  })

  it("ensureDirConfined forwards path and allowed roots", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    await ensureDirConfined("/w/sub", ["/w"])
    expect(callSpy).toHaveBeenCalledWith("ensure_dir_confined", {
      path: "/w/sub",
      allowedRoots: ["/w"],
    })
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
  it("uses the host Skills catalog contract", async () => {
    callSpy.mockResolvedValueOnce({ cognia: [], claude: [], codex: [] })
    await expect(skillsCatalogGet()).resolves.toEqual({ cognia: [], claude: [], codex: [] })
    expect(callSpy).toHaveBeenCalledWith("skills_catalog_get")
  })

  it("forwards every phase of a transactional bundle upload", async () => {
    callSpy
      .mockResolvedValueOnce({ handleId: "upload-1", chunkBytes: 32768 })
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ targets: [], trashedFrom: null })
      .mockResolvedValueOnce(undefined)

    await skillsBundleUploadOpen(4, "a".repeat(64))
    await skillsBundleUploadWrite({
      handleId: "upload-1",
      offset: 0,
      dataBase64: "e30=",
      chunkHash: "b".repeat(64),
    })
    await skillsBundleUploadCommit("upload-1")
    await skillsInstallAtomic("upload-1", "lease-1")
    await skillsBundleUploadAbort("upload-2")

    expect(callSpy.mock.calls).toEqual([
      ["skills_bundle_upload_open", { request: { expectedSize: 4, expectedHash: "a".repeat(64) } }],
      [
        "skills_bundle_upload_write",
        {
          handleId: "upload-1",
          offset: 0,
          dataBase64: "e30=",
          chunkHash: "b".repeat(64),
        },
      ],
      ["skills_bundle_upload_commit", { handleId: "upload-1" }],
      ["skills_install_atomic", { handleId: "upload-1", adminLease: "lease-1" }],
      ["skills_bundle_upload_abort", { handleId: "upload-2" }],
    ])
  })

  it("uninstalls only from the explicitly selected host target", async () => {
    callSpy.mockResolvedValueOnce({ removed: true, directory: "/host/skills/x" })
    await skillsUninstall("codex", "x", "lease-1")
    expect(callSpy).toHaveBeenCalledWith("skills_uninstall", {
      target: "codex",
      dirName: "x",
      adminLease: "lease-1",
    })
  })

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

  it("skillsFetchRemoteJson wraps the request in {req}", async () => {
    callSpy.mockResolvedValueOnce({ status: 200, body: "{}", retryAfter: null })
    await expect(
      skillsFetchRemoteJson({ url: "https://skills.sh/api/search?q=x", bearerToken: "tok" })
    ).resolves.toEqual({ status: 200, body: "{}", retryAfter: null })
    expect(callSpy).toHaveBeenCalledWith("skills_fetch_remote_json", {
      req: { url: "https://skills.sh/api/search?q=x", bearerToken: "tok" },
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

// ── Mobile message + session wrappers (Phase 2) ──────────────────────────

describe("updateMessage", () => {
  it("forwards sessionId / messageId / updates", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    await updateMessage("s1", "m1", { content: "edited" })
    expect(callSpy).toHaveBeenCalledWith("message_update", {
      sessionId: "s1",
      messageId: "m1",
      updates: { content: "edited" },
    })
  })

  it("supports parts-shape updates", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    await updateMessage("s1", "m1", {
      parts: [{ type: "text", text: "x" }] as never,
    })
    expect(callSpy).toHaveBeenCalledWith(
      "message_update",
      expect.objectContaining({ messageId: "m1" })
    )
  })
})

describe("deleteMessage", () => {
  it("forwards sessionId + messageId", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    await deleteMessage("s1", "m1")
    expect(callSpy).toHaveBeenCalledWith("message_delete", {
      sessionId: "s1",
      messageId: "m1",
    })
  })
})

describe("listSessions", () => {
  it("forwards limit/offset/before and returns the SessionListPage", async () => {
    const response = {
      rows: [
        {
          id: "s1",
          title: "Cloud session",
          kind: "direct",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      next_offset: 20,
      has_more: true,
    }
    callSpy.mockResolvedValueOnce(response)
    const page = await listSessions({ limit: 20, offset: 0, before: 1700000000000 })
    expect(page).toEqual(response)
    expect(page.total).toBeUndefined()
    expect(callSpy).toHaveBeenCalledWith("session_list", {
      limit: 20,
      offset: 0,
      before: 1700000000000,
    })
  })

  it("works without an optional before cursor", async () => {
    callSpy.mockResolvedValueOnce({ rows: [], total: 0, next_offset: undefined })
    await listSessions({ limit: 10, offset: 0 })
    expect(callSpy).toHaveBeenCalledWith("session_list", { limit: 10, offset: 0 })
  })
})

describe("getMessagesBySession", () => {
  it("forwards session_id and returns raw StoredMessage rows", async () => {
    const response = {
      rows: [
        {
          id: "m1",
          sessionId: "s1",
          role: "user" as const,
          parts: [{ type: "text" as const, text: "hello" }],
          createdAt: 1,
        },
      ],
      total: 101,
      next_offset: 150,
    }
    callSpy.mockResolvedValueOnce(response)
    const { getMessagesBySession } = require("./ipc") as typeof import("./ipc")
    const page = await getMessagesBySession("s1", 50, 100)
    expect(page).toEqual(response)
    expect(page.rows[0]).toEqual(
      expect.objectContaining({ id: "m1", sessionId: "s1", createdAt: 1 })
    )
    expect(callSpy).toHaveBeenCalledWith("message_get_by_session", {
      session_id: "s1",
      limit: 50,
      offset: 100,
    })
  })

  it("works without pagination args", async () => {
    callSpy.mockResolvedValueOnce({ rows: [], total: 0 })
    const { getMessagesBySession } = require("./ipc") as typeof import("./ipc")
    await getMessagesBySession("s1")
    expect(callSpy).toHaveBeenCalledWith("message_get_by_session", {
      session_id: "s1",
      limit: undefined,
      offset: undefined,
    })
  })
})

describe("sendMessageFromMobile", () => {
  it("forwards session_id / content / role and returns the result", async () => {
    callSpy.mockResolvedValueOnce({ ok: true, messageId: "m-new" })
    const { sendMessageFromMobile } = require("./ipc") as typeof import("./ipc")
    const result = await sendMessageFromMobile("s1", "hello", "user")
    expect(result).toEqual({ ok: true, messageId: "m-new" })
    expect(callSpy).toHaveBeenCalledWith("message_send", {
      session_id: "s1",
      content: "hello",
      role: "user",
    })
  })

  it("omits role when caller doesn't pass it", async () => {
    callSpy.mockResolvedValueOnce({ ok: true })
    const { sendMessageFromMobile } = require("./ipc") as typeof import("./ipc")
    await sendMessageFromMobile("s1", "hello")
    expect(callSpy).toHaveBeenCalledWith("message_send", {
      session_id: "s1",
      content: "hello",
      role: undefined,
    })
  })
})
