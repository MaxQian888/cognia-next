const mockTransportCall = jest.fn()
let mockRemoteActive = false
const mockInvokeVscodeRpc = jest.fn()

jest.mock("@/lib/tauri", () => ({
  transport: { call: (...args: unknown[]) => mockTransportCall(...args) },
}))
jest.mock("@/lib/tauri/transport-routing", () => ({
  isRemoteHostActive: jest.fn(() => mockRemoteActive),
}))
jest.mock("@/lib/plugin/core/vscode-loader", () => ({
  invokeVscodeRpc: (...args: unknown[]) => mockInvokeVscodeRpc(...args),
  isVscodeHostAvailable: jest.fn(() => true),
}))

/**
 * Tests for `TauriLspClientAdapter`. Mocks `invokeVscodeRpc` and the
 * rpc-dispatcher's `registerMethod` so the adapter is tested without
 * any Tauri runtime.
 */

import { LSP_TAURI_CHANNEL_ID, TauriLspClientAdapter } from "./lsp-client-adapter-tauri"

function makeAdapter(opts?: {
  isHostAvailable?: () => boolean
  invokeImpl?: (pluginId: string, method: string, payload: unknown) => Promise<unknown>
}) {
  const invokeCalls: Array<{ pluginId: string; method: string; payload: unknown }> = []
  const handlers = new Map<string, (params: unknown) => unknown>()
  let installCount = 0

  const invoke =
    opts?.invokeImpl ??
    (async (pluginId: string, method: string, payload: unknown) => {
      invokeCalls.push({ pluginId, method, payload })
      return null
    })

  const adapter = new TauriLspClientAdapter({
    invoke,
    registerHandler: (method, handler) => {
      installCount += 1
      handlers.set(method, handler)
      return () => handlers.delete(method)
    },
    isHostAvailable: opts?.isHostAvailable ?? (() => true),
  })

  function firePublishDiagnostics(params: unknown) {
    const handler = handlers.get("lsp:publishDiagnostics")
    if (!handler) throw new Error("test: publishDiagnostics handler not installed")
    handler(params)
  }

  return {
    adapter,
    invokeCalls,
    handlers,
    firePublishDiagnostics,
    installCount: () => installCount,
  }
}

describe("TauriLspClientAdapter", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRemoteActive = false
  })

  it("uses the confined Companion LSP facade when a remote host is active", async () => {
    mockRemoteActive = true
    mockTransportCall.mockResolvedValue(JSON.stringify([{ key: "user:eslint" }]))
    const adapter = new TauriLspClientAdapter({ registerHandler: () => () => {} })

    await expect(adapter.status()).resolves.toEqual([{ key: "user:eslint" }])
    expect(mockTransportCall).toHaveBeenCalledWith("lsp_host_request", {
      method: "lsp:status",
      payloadJson: "{}",
    })
    expect(mockInvokeVscodeRpc).not.toHaveBeenCalled()
  })

  it("keeps the existing VS Code RPC path for the local host", async () => {
    mockInvokeVscodeRpc.mockResolvedValue([{ key: "user:rust-analyzer" }])
    const adapter = new TauriLspClientAdapter({ registerHandler: () => () => {} })

    await expect(adapter.status()).resolves.toEqual([{ key: "user:rust-analyzer" }])
    expect(mockInvokeVscodeRpc).toHaveBeenCalledWith(LSP_TAURI_CHANNEL_ID, "lsp:status", {})
    expect(mockTransportCall).not.toHaveBeenCalled()
  })

  it("start() calls invokeVscodeRpc with the canonical channel and lsp:start method", async () => {
    const { adapter, invokeCalls } = makeAdapter()
    await adapter.start({
      ownerId: "user",
      serverId: "eslint",
      config: {
        id: "eslint",
        name: "ESLint",
        languages: ["typescript"],
        command: "/x/eslint-server",
        args: ["--stdio"],
        transport: "stdio",
      },
      workspaceFolders: [{ uri: "file:///tmp/w", name: "w" }],
      onDiagnostics: jest.fn(),
    })
    expect(invokeCalls).toHaveLength(1)
    expect(invokeCalls[0].pluginId).toBe(LSP_TAURI_CHANNEL_ID)
    expect(invokeCalls[0].method).toBe("lsp:start")
    expect(invokeCalls[0].payload).toMatchObject({
      ownerId: "user",
      serverId: "eslint",
      command: "/x/eslint-server",
      args: ["--stdio"],
      transport: "stdio",
      workspaceFolders: [{ uri: "file:///tmp/w", name: "w" }],
    })
  })

  it("start() throws when the host is unavailable (browser mode)", async () => {
    const { adapter } = makeAdapter({ isHostAvailable: () => false })
    await expect(
      adapter.start({
        ownerId: "user",
        serverId: "eslint",
        config: { id: "eslint", name: "ESLint", languages: ["ts"], command: "/x" },
        onDiagnostics: jest.fn(),
      })
    ).rejects.toThrow(/host unavailable/i)
  })

  it("install() registers exactly one handler and is idempotent", () => {
    const { adapter, installCount } = makeAdapter()
    adapter.install()
    adapter.install()
    expect(installCount()).toBe(1)
  })

  it("forwards lsp:publishDiagnostics through onDiagnostics after running them through the adapter", async () => {
    const onDiagnostics = jest.fn()
    const { adapter, firePublishDiagnostics } = makeAdapter()
    await adapter.start({
      ownerId: "user",
      serverId: "eslint",
      config: { id: "eslint", name: "ESLint", languages: ["ts"], command: "/x" },
      onDiagnostics,
    })
    firePublishDiagnostics({
      ownerId: "user",
      serverId: "eslint",
      uri: "file:///foo.ts",
      diagnostics: [
        {
          severity: 1,
          message: "unused",
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        },
      ],
    })
    expect(onDiagnostics).toHaveBeenCalledTimes(1)
    const [uri, markers] = onDiagnostics.mock.calls[0]
    expect(uri).toBe("file:///foo.ts")
    expect(markers).toHaveLength(1)
    // Severity 1 in LSP = error; bridge severity becomes "error".
    expect(markers[0].severity).toBe("error")
    // Range was 0-based; bridge format is 1-based.
    expect(markers[0].range.startLineNumber).toBe(1)
  })

  it("publishDiagnostics for unknown ownerId/serverId is silently ignored", async () => {
    const onDiagnostics = jest.fn()
    const { adapter, firePublishDiagnostics } = makeAdapter()
    await adapter.start({
      ownerId: "user",
      serverId: "eslint",
      config: { id: "eslint", name: "ESLint", languages: ["ts"], command: "/x" },
      onDiagnostics,
    })
    // Fire for a server we never registered → should NOT throw + NOT
    // call our onDiagnostics.
    expect(() =>
      firePublishDiagnostics({
        ownerId: "user",
        serverId: "rust-analyzer",
        uri: "file:///bar.rs",
        diagnostics: [],
      })
    ).not.toThrow()
    expect(onDiagnostics).not.toHaveBeenCalled()
  })

  it("stop() drops the diagnostic route even if the sidecar errors", async () => {
    const invokeImpl = jest
      .fn()
      .mockResolvedValueOnce(null) // start
      .mockRejectedValueOnce(new Error("sidecar down")) // stop
    const onDiagnostics = jest.fn()
    const { adapter, firePublishDiagnostics } = makeAdapter({ invokeImpl })
    await adapter.start({
      ownerId: "user",
      serverId: "eslint",
      config: { id: "eslint", name: "ESLint", languages: ["ts"], command: "/x" },
      onDiagnostics,
    })
    await expect(adapter.stop("user", "eslint")).resolves.toBeUndefined()
    // After stop, publishDiagnostics must NOT call onDiagnostics.
    firePublishDiagnostics({
      ownerId: "user",
      serverId: "eslint",
      uri: "file:///foo.ts",
      diagnostics: [
        {
          severity: 1,
          message: "x",
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        },
      ],
    })
    expect(onDiagnostics).not.toHaveBeenCalled()
  })

  it("start() failure drops the route so a retry can re-register", async () => {
    const invokeImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error("boom")) // first start fails
      .mockResolvedValueOnce(null) // retry succeeds
    const onDiagnostics = jest.fn()
    const { adapter, firePublishDiagnostics } = makeAdapter({ invokeImpl })
    await expect(
      adapter.start({
        ownerId: "user",
        serverId: "eslint",
        config: { id: "eslint", name: "ESLint", languages: ["ts"], command: "/x" },
        onDiagnostics,
      })
    ).rejects.toThrow(/boom/)
    // Retry — new onDiagnostics should land.
    const onDiagnostics2 = jest.fn()
    await adapter.start({
      ownerId: "user",
      serverId: "eslint",
      config: { id: "eslint", name: "ESLint", languages: ["ts"], command: "/x" },
      onDiagnostics: onDiagnostics2,
    })
    firePublishDiagnostics({
      ownerId: "user",
      serverId: "eslint",
      uri: "file:///x.ts",
      diagnostics: [
        {
          severity: 2,
          message: "warn",
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        },
      ],
    })
    expect(onDiagnostics).not.toHaveBeenCalled()
    expect(onDiagnostics2).toHaveBeenCalledTimes(1)
  })

  it("didOpen / didChange / didClose / request route via lsp:* RPC methods", async () => {
    const { adapter, invokeCalls } = makeAdapter()
    await adapter.didOpen({
      ownerId: "user",
      serverId: "eslint",
      uri: "file:///foo.ts",
      languageId: "ts",
      text: "x",
    })
    await adapter.didChange({
      ownerId: "user",
      serverId: "eslint",
      uri: "file:///foo.ts",
      text: "y",
    })
    await adapter.didClose({ ownerId: "user", serverId: "eslint", uri: "file:///foo.ts" })
    await adapter.request({
      ownerId: "user",
      serverId: "eslint",
      method: "completion",
      payload: { uri: "file:///foo.ts", position: { line: 0, character: 0 } },
    })
    const methods = invokeCalls.map((c) => c.method)
    expect(methods).toEqual(["lsp:didOpen", "lsp:didChange", "lsp:didClose", "lsp:request"])
  })

  it("stop() in browser mode (host unavailable) succeeds without invoking", async () => {
    const invokeImpl = jest.fn()
    const { adapter } = makeAdapter({ invokeImpl, isHostAvailable: () => false })
    await expect(adapter.stop("user", "eslint")).resolves.toBeUndefined()
    expect(invokeImpl).not.toHaveBeenCalled()
  })
})
