import { codeServerClient } from "@/lib/codeserver/client"

import type { ManagedProtocolRuntimeDependencies } from "./protocol-runtime"
import { ManagedProtocolRuntime } from "./protocol-runtime"

const mockEnsureEditorLspRuntime = jest.fn(async () => undefined)
const mockInvokeVscodeRpc = jest.fn()
const mockIsRemoteHostActive = jest.fn(() => false)
const mockTransportCall = jest.fn()

jest.mock("@/lib/lsp/ensure-editor-lsp-runtime", () => ({
  ensureEditorLspRuntime: () => mockEnsureEditorLspRuntime(),
}))
jest.mock("@/lib/plugin/core/vscode-loader", () => ({
  invokeVscodeRpc: (pluginId: string, method: string, payload: unknown) =>
    mockInvokeVscodeRpc(pluginId, method, payload),
}))
jest.mock("@/lib/tauri/transport-routing", () => ({
  isRemoteHostActive: () => mockIsRemoteHostActive(),
}))
jest.mock("@/lib/tauri", () => ({
  transport: {
    call: (command: string, payload?: unknown) => mockTransportCall(command, payload),
  },
}))

function dependencies(
  overrides: Partial<ManagedProtocolRuntimeDependencies> = {}
): ManagedProtocolRuntimeDependencies {
  return {
    listProxies: jest.fn(async () => [
      {
        pluginId: "acme",
        pluginVersion: "1.0.0",
        manifestHash: "sha256:manifest",
        catalogHash: "sha256:catalog",
        platformVersion: "1.0.0",
        sha256: "digest",
        signature: "signature",
        publicKey: "key",
        vsixPath: "/cache/proxy.vsix",
        executables: [
          { id: "server", sha256: `sha256:${"a".repeat(64)}`, path: "/cache/bin/server" },
        ],
      },
    ]),
    ensureHost: jest.fn(async () => undefined),
    createLspAdapter: () =>
      ({
        start: jest.fn(async () => undefined),
        stop: jest.fn(async () => undefined),
        request: jest.fn(async (input) => ({ method: input.method })),
        didOpen: jest.fn(async () => undefined),
        didChange: jest.fn(async () => undefined),
        didClose: jest.fn(async () => undefined),
        serverResponse: jest.fn(async () => true),
        clientNotification: jest.fn(async () => true),
        detect: jest.fn(async () => []),
      }) as never,
    notify: jest.fn(async () => undefined),
    invokeHost: jest.fn(async () => ({ state: "running" })),
    onHostMessage: jest.fn(() => () => undefined),
    readSetting: jest.fn(),
    ...overrides,
  }
}

const startInput = {
  root: "/work/project",
  generation: 7,
  pluginId: "acme",
  pluginVersion: "1.0.0",
  manifestHash: "sha256:manifest",
  family: "lsp" as const,
  server: {
    id: "cognia.acme.language",
    executable: "server",
    transport: "stdio" as const,
    languages: ["typescript"],
  },
  executable: {
    id: "server",
    source: {
      kind: "plugin-resource" as const,
      path: "bin/server",
      sha256: `sha256:${"a".repeat(64)}`,
    },
    args: ["--stdio"],
  },
}

describe("ManagedProtocolRuntime", () => {
  afterEach(() => {
    jest.restoreAllMocks()
    mockEnsureEditorLspRuntime.mockClear()
    mockInvokeVscodeRpc.mockReset()
    mockIsRemoteHostActive.mockReset()
    mockIsRemoteHostActive.mockReturnValue(false)
    mockTransportCall.mockReset()
  })

  it("starts a Pro-only LSP session from the verified staged artifact", async () => {
    const start = jest.fn(async () => undefined)
    const deps = dependencies({
      createLspAdapter: () =>
        ({
          start,
          stop: jest.fn(),
          request: jest.fn(),
          didOpen: jest.fn(),
          didChange: jest.fn(),
          didClose: jest.fn(),
          serverResponse: jest.fn(),
          clientNotification: jest.fn(),
          detect: jest.fn(),
        }) as never,
    })
    const runtime = new ManagedProtocolRuntime(deps)
    await expect(runtime.start(startInput)).resolves.toEqual({
      sessionId: expect.stringContaining("cognia.acme.language"),
    })
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "managed-pro:acme:/work/project",
        serverId: "cognia.acme.language",
        config: expect.objectContaining({
          command: "/cache/bin/server",
          args: ["--stdio"],
        }),
      })
    )
  })

  it("rejects an executable not present in the verified signed proxy", async () => {
    const runtime = new ManagedProtocolRuntime(dependencies({ listProxies: async () => [] }))
    await expect(runtime.start(startInput)).rejects.toThrow("IDE_EXECUTABLE_ARTIFACT_NOT_VERIFIED")
  })

  it("routes requests and full document synchronization to the independent session", async () => {
    const request = jest.fn(async (input) => ({ method: input.method }))
    const didOpen = jest.fn(async () => undefined)
    const runtime = new ManagedProtocolRuntime(
      dependencies({
        createLspAdapter: () =>
          ({
            start: jest.fn(async () => undefined),
            stop: jest.fn(),
            request,
            didOpen,
            didChange: jest.fn(),
            didClose: jest.fn(),
            serverResponse: jest.fn(),
            clientNotification: jest.fn(),
            detect: jest.fn(),
          }) as never,
      })
    )
    await runtime.start(startInput)
    await expect(
      runtime.request({
        root: startInput.root,
        generation: 7,
        pluginId: "acme",
        family: "lsp",
        protocolId: startInput.server.id,
        invocationId: "hover-1",
        method: "textDocument/hover",
        payload: { textDocument: { uri: "file:///work/project/a.ts" } },
      })
    ).resolves.toEqual({ method: "textDocument/hover" })
    await runtime.document({
      root: startInput.root,
      generation: 7,
      pluginId: "acme",
      family: "lsp",
      protocolId: startInput.server.id,
      operation: "open",
      uri: "file:///work/project/a.ts",
      languageId: "typescript",
      text: "const a = 1",
    })
    expect(request).toHaveBeenCalled()
    expect(didOpen).toHaveBeenCalledWith(
      expect.objectContaining({ languageId: "typescript", text: "const a = 1" })
    )
  })

  it("projects LSP server callbacks and correlates the proxy response", async () => {
    const notify = jest.fn(async () => undefined)
    const serverResponse = jest.fn(async () => true)
    let startOptions:
      | Parameters<ReturnType<ManagedProtocolRuntimeDependencies["createLspAdapter"]>["start"]>[0]
      | undefined
    const runtime = new ManagedProtocolRuntime(
      dependencies({
        notify,
        createLspAdapter: () =>
          ({
            start: jest.fn(async (input) => {
              startOptions = input
            }),
            stop: jest.fn(),
            request: jest.fn(),
            didOpen: jest.fn(),
            didChange: jest.fn(),
            didClose: jest.fn(),
            serverResponse,
            clientNotification: jest.fn(async () => true),
            detect: jest.fn(),
          }) as never,
      })
    )
    await runtime.start(startInput)
    startOptions?.onServerRequest?.({
      requestId: "server-1",
      method: "workspace/applyEdit",
      payload: { edit: { changes: {} } },
      preconditions: {},
    })
    expect(notify).toHaveBeenCalledWith(
      startInput.root,
      startInput.generation,
      expect.objectContaining({
        event: "serverRequest",
        payload: expect.objectContaining({ requestId: "server-1" }),
      })
    )

    await expect(
      runtime.request({
        root: startInput.root,
        generation: startInput.generation,
        pluginId: startInput.pluginId,
        family: "lsp",
        protocolId: startInput.server.id,
        invocationId: "authorize-1",
        method: "$/cognia/authorizeServerRequest",
        payload: { requestId: "server-1" },
      })
    ).resolves.toEqual({ authorized: true })
    await expect(
      runtime.request({
        root: startInput.root,
        generation: startInput.generation,
        pluginId: startInput.pluginId,
        family: "lsp",
        protocolId: startInput.server.id,
        invocationId: "response-1",
        method: "$/cognia/serverResponse",
        payload: { requestId: "server-1", result: { applied: true } },
      })
    ).resolves.toEqual({ accepted: true })
    expect(serverResponse).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "server-1", result: { applied: true } })
    )
  })

  it("supervises DAP and MCP on the Cognia host and returns only loopback connection data", async () => {
    const invokeHost = jest
      .fn()
      .mockResolvedValueOnce({
        state: "running",
        endpoint: "http://127.0.0.1:41000/mcp",
        headers: { Authorization: "Bearer scoped" },
      })
      .mockResolvedValueOnce({ jsonrpc: "2.0", id: 1, result: { tools: [] } })
    const runtime = new ManagedProtocolRuntime(dependencies({ invokeHost }))
    const mcp = {
      ...startInput,
      family: "mcp" as const,
      server: {
        ...startInput.server,
        id: "cognia.acme.tools",
        transport: "stdio" as const,
      },
    }
    await expect(runtime.start(mcp)).resolves.toMatchObject({
      connection: {
        endpoint: "http://127.0.0.1:41000/mcp",
        headers: { Authorization: "Bearer scoped" },
      },
    })
    await expect(
      runtime.request({
        root: mcp.root,
        generation: mcp.generation,
        pluginId: mcp.pluginId,
        family: "mcp",
        protocolId: mcp.server.id,
        invocationId: "tools-list-1",
        method: "message",
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      })
    ).resolves.toMatchObject({ result: { tools: [] } })
    expect(invokeHost).toHaveBeenNthCalledWith(
      1,
      "protocol:start",
      expect.objectContaining({ family: "mcp", command: "/cache/bin/server" })
    )
  })

  it("isolates concurrent DAP consumers into independent supervised processes", async () => {
    const invokeHost = jest.fn(async () => ({ state: "running" }))
    const runtime = new ManagedProtocolRuntime(dependencies({ invokeHost }))
    const dap = {
      ...startInput,
      family: "dap" as const,
      server: {
        ...startInput.server,
        id: "cognia.acme.debug",
        transport: "stdio" as const,
      },
    }
    await runtime.start({ ...dap, consumerId: "debug-session-a" })
    await runtime.start({ ...dap, consumerId: "debug-session-b" })
    expect(invokeHost).toHaveBeenNthCalledWith(
      1,
      "protocol:start",
      expect.objectContaining({ ownerId: expect.stringContaining("debug-session-a") })
    )
    expect(invokeHost).toHaveBeenNthCalledWith(
      2,
      "protocol:start",
      expect.objectContaining({ ownerId: expect.stringContaining("debug-session-b") })
    )
  })

  it("routes cancellation to the exact consumer session", async () => {
    const invokeHost = jest
      .fn()
      .mockResolvedValueOnce({ state: "running" })
      .mockResolvedValueOnce({ cancelled: true })
    const runtime = new ManagedProtocolRuntime(dependencies({ invokeHost }))
    const dap = {
      ...startInput,
      family: "dap" as const,
      consumerId: "debug-session-a",
      server: {
        ...startInput.server,
        id: "cognia.acme.debug",
        transport: "stdio" as const,
      },
    }
    await runtime.start(dap)
    await expect(
      runtime.cancel({
        root: dap.root,
        generation: dap.generation,
        pluginId: dap.pluginId,
        protocolId: dap.server.id,
        consumerId: dap.consumerId,
        invocationId: "request-1",
      })
    ).resolves.toBe(true)
    expect(invokeHost).toHaveBeenLastCalledWith(
      "protocol:cancel",
      expect.objectContaining({
        ownerId: expect.stringContaining("debug-session-a"),
        requestId: "request-1",
      })
    )
  })

  it("returns LSP capabilities, emits every callback, and reuses an existing session", async () => {
    const notify = jest.fn(async () => undefined)
    const start = jest.fn(async (input) => {
      input.onDiagnostics?.("file:///work/project/a.ts", [{ message: "bad" }] as never)
      input.onServerRequest?.({
        requestId: "server-1",
        method: "workspace/configuration",
        payload: {},
      })
      input.onServerNotification?.({ method: "window/logMessage", payload: { message: "hi" } })
      return { capabilities: { hoverProvider: true } }
    })
    const runtime = new ManagedProtocolRuntime(
      dependencies({
        notify,
        createLspAdapter: () =>
          ({
            start,
            stop: jest.fn(),
            request: jest.fn(),
            didOpen: jest.fn(),
            didChange: jest.fn(),
            didClose: jest.fn(),
            serverResponse: jest.fn(),
            clientNotification: jest.fn(),
            detect: jest.fn(),
          }) as never,
      })
    )

    await expect(runtime.start(startInput)).resolves.toMatchObject({
      connection: { capabilities: { hoverProvider: true } },
    })
    await expect(runtime.start(startInput)).resolves.toEqual({
      sessionId: expect.stringContaining("cognia.acme.language"),
    })
    expect(start).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(
      startInput.root,
      startInput.generation,
      expect.objectContaining({ event: "diagnostics" })
    )
    expect(notify).toHaveBeenCalledWith(
      startInput.root,
      startInput.generation,
      expect.objectContaining({ event: "serverRequest" })
    )
    expect(notify).toHaveBeenCalledWith(
      startInput.root,
      startInput.generation,
      expect.objectContaining({ event: "serverNotification" })
    )
  })

  it("resolves registered tools and user-selected executables and rejects missing selections", async () => {
    const detect = jest.fn(async () => [
      { serverId: "cognia.acme.language", resolvedPath: "/bin/ts" },
    ])
    const start = jest.fn(async () => undefined)
    const deps = dependencies({
      createLspAdapter: () =>
        ({
          start,
          stop: jest.fn(),
          request: jest.fn(),
          didOpen: jest.fn(),
          didChange: jest.fn(),
          didClose: jest.fn(),
          serverResponse: jest.fn(),
          clientNotification: jest.fn(),
          detect,
        }) as never,
      readSetting: jest.fn(() => "/opt/tools/language-server"),
    })
    const runtime = new ManagedProtocolRuntime(deps)
    await runtime.start({
      ...startInput,
      executable: {
        ...startInput.executable,
        source: { kind: "registered-tool", tool: "typescript-language-server" },
      },
    })
    expect(detect).toHaveBeenCalledWith({
      servers: [
        {
          serverId: startInput.server.id,
          command: "typescript-language-server",
        },
      ],
      projectRoot: startInput.root,
    })
    expect(start).toHaveBeenLastCalledWith(
      expect.objectContaining({ config: expect.objectContaining({ command: "/bin/ts" }) })
    )

    await runtime.start({
      ...startInput,
      generation: 8,
      executable: {
        ...startInput.executable,
        source: { kind: "user-selected", setting: "ide.languageServer" },
      },
    })
    expect(start).toHaveBeenLastCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ command: "/opt/tools/language-server" }),
      })
    )

    const missingTool = new ManagedProtocolRuntime(
      dependencies({
        createLspAdapter: () =>
          ({
            ...deps.createLspAdapter(),
            detect: jest.fn(async () => []),
          }) as never,
      })
    )
    await expect(
      missingTool.start({
        ...startInput,
        executable: {
          ...startInput.executable,
          source: { kind: "registered-tool", tool: "missing" },
        },
      })
    ).rejects.toThrow("IDE_REGISTERED_TOOL_NOT_FOUND")
    await expect(
      new ManagedProtocolRuntime(dependencies()).start({
        ...startInput,
        executable: {
          ...startInput.executable,
          source: { kind: "user-selected", setting: "ide.languageServer" },
        },
      })
    ).rejects.toThrow("IDE_USER_EXECUTABLE_NOT_SELECTED")
  })

  it("validates correlated LSP responses and client notifications", async () => {
    const clientNotification = jest.fn(async () => false)
    const serverResponse = jest.fn(async () => true)
    const runtime = new ManagedProtocolRuntime(
      dependencies({
        createLspAdapter: () =>
          ({
            start: jest.fn(async () => undefined),
            stop: jest.fn(),
            request: jest.fn(),
            didOpen: jest.fn(),
            didChange: jest.fn(),
            didClose: jest.fn(),
            serverResponse,
            clientNotification,
            detect: jest.fn(),
          }) as never,
      })
    )
    await runtime.start(startInput)
    const common = {
      root: startInput.root,
      generation: startInput.generation,
      pluginId: startInput.pluginId,
      family: "lsp" as const,
      protocolId: startInput.server.id,
      invocationId: "callback-1",
    }
    await expect(
      runtime.request({
        ...common,
        method: "$/cognia/clientNotification",
        payload: { method: "window/logMessage", payload: { message: "hello" } },
      })
    ).resolves.toEqual({ accepted: false })
    expect(clientNotification).toHaveBeenCalledWith(
      expect.objectContaining({ method: "window/logMessage" })
    )
    await expect(
      runtime.request({
        ...common,
        method: "$/cognia/clientNotification",
        payload: { method: 4 },
      })
    ).rejects.toThrow("IDE_LSP_CLIENT_NOTIFICATION_METHOD_REQUIRED")
    await expect(
      runtime.request({
        ...common,
        method: "$/cognia/serverResponse",
        payload: {},
      })
    ).rejects.toThrow("IDE_LSP_SERVER_REQUEST_ID_REQUIRED")
    await expect(
      runtime.request({
        ...common,
        method: "$/cognia/authorizeServerRequest",
        payload: {},
      })
    ).rejects.toThrow("IDE_LSP_SERVER_REQUEST_ID_REQUIRED")
  })

  it("validates session identity and every document synchronization operation", async () => {
    const didOpen = jest.fn(async () => undefined)
    const didChange = jest.fn(async () => undefined)
    const didClose = jest.fn(async () => undefined)
    const runtime = new ManagedProtocolRuntime(
      dependencies({
        createLspAdapter: () =>
          ({
            start: jest.fn(async () => undefined),
            stop: jest.fn(),
            request: jest.fn(),
            didOpen,
            didChange,
            didClose,
            serverResponse: jest.fn(),
            clientNotification: jest.fn(),
            detect: jest.fn(),
          }) as never,
      })
    )
    await expect(
      runtime.request({
        root: startInput.root,
        generation: 99,
        pluginId: "acme",
        family: "lsp",
        protocolId: startInput.server.id,
        invocationId: "missing",
        method: "textDocument/hover",
        payload: {},
      })
    ).rejects.toThrow("IDE_PROTOCOL_SESSION_NOT_RUNNING")
    await runtime.start(startInput)
    const base = {
      root: startInput.root,
      generation: startInput.generation,
      pluginId: startInput.pluginId,
      family: "lsp" as const,
      protocolId: startInput.server.id,
      uri: "file:///work/project/a.ts",
    }
    await runtime.document({ ...base, operation: "change", text: "changed" })
    await runtime.document({ ...base, operation: "close" })
    expect(didChange).toHaveBeenCalledWith(expect.objectContaining({ text: "changed" }))
    expect(didClose).toHaveBeenCalledWith(expect.objectContaining({ uri: base.uri }))
    await expect(runtime.document({ ...base, operation: "change" })).rejects.toThrow(
      "IDE_LSP_DOCUMENT_INVALID"
    )
    await expect(runtime.document({ ...base, operation: "open", text: "x" })).rejects.toThrow(
      "IDE_LSP_DOCUMENT_INVALID"
    )
    await expect(
      runtime.document({ ...base, generation: 100, operation: "close" })
    ).rejects.toThrow("IDE_PROTOCOL_SESSION_NOT_RUNNING")
  })

  it("stops exact sessions, evicts stale generations, and treats missing work as idempotent", async () => {
    const stop = jest.fn(async () => undefined)
    const invokeHost = jest.fn(async (method: string) =>
      method.endsWith("cancel") ? { cancelled: false } : { state: "running" }
    )
    const runtime = new ManagedProtocolRuntime(
      dependencies({
        invokeHost,
        createLspAdapter: () =>
          ({
            start: jest.fn(async () => undefined),
            stop,
            request: jest.fn(),
            didOpen: jest.fn(),
            didChange: jest.fn(),
            didClose: jest.fn(),
            serverResponse: jest.fn(),
            clientNotification: jest.fn(),
            detect: jest.fn(),
          }) as never,
      })
    )
    expect(
      await runtime.cancel({
        root: startInput.root,
        generation: 1,
        pluginId: "acme",
        protocolId: "missing",
        invocationId: "missing",
      })
    ).toBe(false)
    await runtime.stop({
      root: startInput.root,
      generation: 1,
      pluginId: "acme",
      protocolId: "missing",
    })
    await runtime.start(startInput)
    await expect(
      runtime.cancel({
        root: startInput.root,
        generation: 7,
        pluginId: "acme",
        protocolId: startInput.server.id,
        invocationId: "hover",
      })
    ).resolves.toBe(false)
    await runtime.start({ ...startInput, generation: 8 })
    expect(stop).toHaveBeenCalledWith("managed-pro:acme:/work/project", startInput.server.id)
    await runtime.stop({
      root: startInput.root,
      generation: 8,
      pluginId: "acme",
      protocolId: startInput.server.id,
    })
    expect(stop).toHaveBeenCalledTimes(2)

    const dap = {
      ...startInput,
      family: "dap" as const,
      server: { ...startInput.server, id: "cognia.acme.debug" },
    }
    await runtime.start(dap)
    await runtime.start({ ...dap, generation: 9 })
    expect(invokeHost).toHaveBeenCalledWith(
      "protocol:stop",
      expect.objectContaining({ serverId: "cognia.acme.debug" })
    )
    await runtime.stop({
      root: dap.root,
      generation: 9,
      pluginId: dap.pluginId,
      protocolId: dap.server.id,
    })
  })

  it("projects valid host messages to the exact protocol consumer and ignores forged messages", async () => {
    let hostListener: ((method: string, params: unknown) => void) | undefined
    const notify = jest.fn(async () => undefined)
    const runtime = new ManagedProtocolRuntime(
      dependencies({
        notify,
        onHostMessage: (listener) => {
          hostListener = listener
          return () => undefined
        },
      })
    )
    const mcp = {
      ...startInput,
      family: "mcp" as const,
      consumerId: "chat",
      server: { ...startInput.server, id: "cognia.acme.mcp" },
    }
    await runtime.start(mcp)
    hostListener?.("unknown", {})
    hostListener?.("protocol:message", { ownerId: 1, serverId: "cognia.acme.mcp" })
    hostListener?.("protocol:message", { ownerId: "other", serverId: "cognia.acme.mcp" })
    expect(notify).not.toHaveBeenCalled()
    hostListener?.("protocol:message", {
      ownerId: "managed-pro:acme:/work/project:chat",
      serverId: "cognia.acme.mcp",
      body: { jsonrpc: "2.0" },
    })
    hostListener?.("protocol:state", {
      ownerId: "managed-pro:acme:/work/project:chat",
      serverId: "cognia.acme.mcp",
      state: "broken",
    })
    expect(notify).toHaveBeenNthCalledWith(
      1,
      startInput.root,
      startInput.generation,
      expect.objectContaining({ event: "message", consumerId: "chat" })
    )
    expect(notify).toHaveBeenNthCalledWith(
      2,
      startInput.root,
      startInput.generation,
      expect.objectContaining({ event: "state", consumerId: "chat" })
    )
  })

  it("disposes every session and unregisters the host listener exactly once", async () => {
    const stop = jest.fn(async () => undefined)
    const removeHostListener = jest.fn()
    const invokeHost = jest.fn(async () => ({ state: "running" }))
    const runtime = new ManagedProtocolRuntime(
      dependencies({
        invokeHost,
        onHostMessage: () => removeHostListener,
        createLspAdapter: () =>
          ({
            start: jest.fn(async () => undefined),
            stop,
            request: jest.fn(),
            didOpen: jest.fn(),
            didChange: jest.fn(),
            didClose: jest.fn(),
            serverResponse: jest.fn(),
            clientNotification: jest.fn(),
            detect: jest.fn(),
          }) as never,
      })
    )
    await runtime.start(startInput)
    await runtime.start({
      ...startInput,
      family: "mcp",
      server: { ...startInput.server, id: "cognia.acme.mcp" },
    })

    await runtime.dispose()
    await runtime.dispose()
    expect(stop).toHaveBeenCalledWith("managed-pro:acme:/work/project", startInput.server.id)
    expect(invokeHost).toHaveBeenCalledWith(
      "protocol:stop",
      expect.objectContaining({ serverId: "cognia.acme.mcp" })
    )
    expect(removeHostListener).toHaveBeenCalledTimes(1)
  })

  it("uses the local default host transport and rejects an unset user executable", async () => {
    const artifact = (await dependencies().listProxies())[0]!
    jest.spyOn(codeServerClient, "listProxies").mockResolvedValue([artifact])
    const invoke = mockInvokeVscodeRpc
      .mockResolvedValueOnce({ state: "running" })
      .mockResolvedValueOnce({ response: true })
      .mockResolvedValueOnce(null)
    const runtime = new ManagedProtocolRuntime()
    const dap = {
      ...startInput,
      family: "dap" as const,
      server: { ...startInput.server, id: "cognia.acme.debug" },
    }

    await runtime.start(dap)
    await expect(
      runtime.request({
        root: dap.root,
        generation: dap.generation,
        pluginId: dap.pluginId,
        family: "dap",
        protocolId: dap.server.id,
        invocationId: "debug-1",
        method: "message",
        payload: { command: "threads" },
      })
    ).resolves.toEqual({ response: true })
    expect(invoke).toHaveBeenCalledWith(
      expect.any(String),
      "protocol:start",
      expect.objectContaining({ family: "dap" })
    )
    await runtime.dispose()

    await expect(
      new ManagedProtocolRuntime().start({
        ...startInput,
        executable: {
          ...startInput.executable,
          source: { kind: "user-selected", setting: "managedIde.missingExecutable" },
        },
      })
    ).rejects.toThrow("IDE_USER_EXECUTABLE_NOT_SELECTED")
  })

  it("uses the paired companion host transport and parses nullable RPC results", async () => {
    const artifact = (await dependencies().listProxies())[0]!
    jest.spyOn(codeServerClient, "listProxies").mockResolvedValue([artifact])
    mockIsRemoteHostActive.mockReturnValue(true)
    const call = mockTransportCall
      .mockResolvedValueOnce(
        JSON.stringify({
          state: "running",
          endpoint: "http://127.0.0.1:44000/mcp",
        })
      )
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
    const runtime = new ManagedProtocolRuntime()
    const mcp = {
      ...startInput,
      family: "mcp" as const,
      server: { ...startInput.server, id: "cognia.acme.mcp" },
    }

    await expect(runtime.start(mcp)).resolves.toMatchObject({
      connection: { endpoint: "http://127.0.0.1:44000/mcp" },
    })
    await expect(
      runtime.request({
        root: mcp.root,
        generation: mcp.generation,
        pluginId: mcp.pluginId,
        family: "mcp",
        protocolId: mcp.server.id,
        invocationId: "tools-1",
        method: "message",
        payload: { jsonrpc: "2.0", method: "tools/list" },
      })
    ).resolves.toBeNull()
    await runtime.dispose()
    expect(call).toHaveBeenCalledWith(
      "lsp_host_request",
      expect.objectContaining({
        method: "protocol:start",
        payloadJson: expect.any(String),
      })
    )
  })
})
