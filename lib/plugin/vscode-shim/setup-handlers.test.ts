/**
 * `installVscodeRpcHandlers` wires the canonical VS Code RPC methods to
 * their handler functions. The contract is:
 *
 *   1. Calling it once registers every `lm:*` and `chat:*` method listed
 *      in the source.
 *   2. Calling it twice is idempotent — the second call is a no-op and
 *      returns a disposer that is also a no-op.
 *   3. The disposer returned by the first call drops every registration.
 *
 * The setup-handlers module guards itself with a module-scoped `installed`
 * flag. The tests below run inside `jest.isolateModules(...)` so each test
 * gets a fresh module instance (and a fresh handler registry), keeping the
 * `installed` flag and the `handlers` Map in lock-step.
 */

jest.mock("./lm-handler", () => ({
  handleRegisterChatModelProvider: jest.fn(),
  handleRegisterMcpServerDefinitionProvider: jest.fn(),
  handleRegisterTool: jest.fn(),
  handleSelectChatModels: jest.fn(),
  handleSendChatRequest: jest.fn(),
  handleUnregisterChatModelProvider: jest.fn(),
  handleUnregisterMcpServerDefinitionProvider: jest.fn(),
  handleUnregisterTool: jest.fn(),
}))

jest.mock("./chat-participant-registry", () => ({
  handleChatParticipantRespond: jest.fn(),
  handleCreateChatParticipant: jest.fn(),
  handleDisposeChatParticipant: jest.fn(),
  handleRegisterChatVariableResolver: jest.fn(),
}))

jest.mock("./languages-handler", () => ({
  handleExtensionCleanup: jest.fn(),
  handleLanguagesRegister: jest.fn(() => ({ token: "tk" })),
  handleLanguagesRegisterDecorationType: jest.fn(() => ({ typeId: "td" })),
  handleLanguagesSetDecorations: jest.fn(),
  handleLanguagesSetDiagnostics: jest.fn(),
  handleLanguagesUnregister: jest.fn(() => ({ removed: true })),
  handleWindowActiveTextEditorGet: jest.fn(() => null),
}))

jest.mock("./lsp-workspace-manager", () => ({
  listWorkspaceFolders: jest.fn(() => []),
  resolveWorkspaceFolder: jest.fn(() => null),
}))

const EXPECTED_METHODS = [
  "lm:selectChatModels",
  "lm:sendChatRequest",
  "lm:registerChatModelProvider",
  "lm:unregisterChatModelProvider",
  "lm:registerMcpServerDefinitionProvider",
  "lm:unregisterMcpServerDefinitionProvider",
  "lm:registerTool",
  "lm:unregisterTool",
  "chat:createParticipant",
  "chat:disposeParticipant",
  "chat:registerVariableResolver",
  "chat:respond",
  "languages:register",
  "languages:unregister",
  "languages:setDiagnostics",
  "languages:clearDiagnostics",
  "languages:registerDecorationType",
  "languages:setDecorations",
  "extension:cleanup",
  "window:activeTextEditor:get",
  "workspace:listFolders",
  "workspace:getWorkspaceFolder",
]

interface IsolatedModules {
  install: () => () => void
  listMethods: () => string[]
  reset: () => void
}

function loadInIsolation(): IsolatedModules {
  let install!: () => () => void
  let listMethods!: () => string[]
  let reset!: () => void
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const setup = require("./setup-handlers") as {
      installVscodeRpcHandlers: () => () => void
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dispatcher = require("./rpc-dispatcher") as {
      listRegisteredMethods: () => string[]
      resetRegistry: () => void
    }
    install = setup.installVscodeRpcHandlers
    listMethods = dispatcher.listRegisteredMethods
    reset = dispatcher.resetRegistry
  })
  return { install, listMethods, reset }
}

describe("installVscodeRpcHandlers", () => {
  it("registers every canonical VS Code RPC method on first call", () => {
    const { install, listMethods, reset } = loadInIsolation()
    try {
      install()
      const methods = listMethods()
      for (const expected of EXPECTED_METHODS) {
        expect(methods).toContain(expected)
      }
    } finally {
      reset()
    }
  })

  it("is idempotent — second call returns a no-op disposer that doesn't drop the first registration", () => {
    const { install, listMethods, reset } = loadInIsolation()
    try {
      const firstDisposer = install()
      const beforeSecond = listMethods().length
      const secondDisposer = install()
      const afterSecond = listMethods().length

      expect(afterSecond).toBe(beforeSecond)

      // Second disposer is a no-op — calling it must not drop the first
      // registration set.
      secondDisposer()
      expect(listMethods().length).toBe(beforeSecond)

      // The first disposer is the real one — it tears everything down.
      firstDisposer()
      expect(listMethods()).toEqual([])
    } finally {
      reset()
    }
  })

  it("disposer dropped every registered method", () => {
    const { install, listMethods, reset } = loadInIsolation()
    try {
      const disposer = install()
      expect(listMethods().length).toBeGreaterThanOrEqual(EXPECTED_METHODS.length)
      disposer()
      expect(listMethods()).toEqual([])
    } finally {
      reset()
    }
  })

  it("registers both lm:* and chat:* method families", () => {
    const { install, listMethods, reset } = loadInIsolation()
    try {
      install()
      const methods = listMethods()
      const lmCount = methods.filter((m) => m.startsWith("lm:")).length
      const chatCount = methods.filter((m) => m.startsWith("chat:")).length
      expect(lmCount).toBe(8)
      expect(chatCount).toBe(4)
    } finally {
      reset()
    }
  })

  it("registers languages:* + extension:cleanup + window:activeTextEditor:get for the LSP path", () => {
    const { install, listMethods, reset } = loadInIsolation()
    try {
      install()
      const methods = listMethods()
      expect(methods.filter((m) => m.startsWith("languages:")).length).toBe(6)
      expect(methods).toContain("extension:cleanup")
      expect(methods).toContain("window:activeTextEditor:get")
    } finally {
      reset()
    }
  })

  it("languages:setDiagnostics converts VSCode-shape diagnostics through the adapter before forwarding to the bridge", async () => {
    let handleInboundFrame!: (pluginId: string, raw: string) => Promise<void>
    let setDiagnosticsSpy!: jest.Mock
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const setup = require("./setup-handlers") as {
        installVscodeRpcHandlers: () => () => void
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const dispatcher = require("./rpc-dispatcher") as {
        handleInboundFrame: (pluginId: string, raw: string) => Promise<void>
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const languagesHandler = require("./languages-handler") as {
        handleLanguagesSetDiagnostics: jest.Mock
      }
      setup.installVscodeRpcHandlers()
      handleInboundFrame = dispatcher.handleInboundFrame
      setDiagnosticsSpy = languagesHandler.handleLanguagesSetDiagnostics
      setDiagnosticsSpy.mockClear()
    })

    await handleInboundFrame(
      "ext.eslint",
      JSON.stringify({
        jsonrpc: "2.0",
        method: "languages:setDiagnostics",
        params: {
          extensionId: "ext.eslint",
          uri: "file:///x.ts",
          diagnostics: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
              severity: 0, // VSCode Error
              message: "boom",
              source: "eslint",
            },
            {
              range: { start: { line: 2, character: 1 }, end: { line: 2, character: 8 } },
              severity: 1, // VSCode Warning
              message: "unused",
            },
          ],
        },
      })
    )

    expect(setDiagnosticsSpy).toHaveBeenCalledTimes(1)
    const arg = setDiagnosticsSpy.mock.calls[0][0]
    expect(arg.extensionId).toBe("ext.eslint")
    expect(arg.uri).toBe("file:///x.ts")
    expect(arg.markers).toHaveLength(2)
    expect(arg.markers[0]).toMatchObject({
      severity: "error",
      message: "boom",
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 },
      source: "eslint",
    })
    expect(arg.markers[1]).toMatchObject({ severity: "warning", message: "unused" })
  })

  it("languages:clearDiagnostics forwards an empty marker list", async () => {
    let handleInboundFrame!: (pluginId: string, raw: string) => Promise<void>
    let setDiagnosticsSpy!: jest.Mock
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const setup = require("./setup-handlers") as {
        installVscodeRpcHandlers: () => () => void
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const dispatcher = require("./rpc-dispatcher") as {
        handleInboundFrame: (pluginId: string, raw: string) => Promise<void>
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const languagesHandler = require("./languages-handler") as {
        handleLanguagesSetDiagnostics: jest.Mock
      }
      setup.installVscodeRpcHandlers()
      handleInboundFrame = dispatcher.handleInboundFrame
      setDiagnosticsSpy = languagesHandler.handleLanguagesSetDiagnostics
      setDiagnosticsSpy.mockClear()
    })

    await handleInboundFrame(
      "ext.eslint",
      JSON.stringify({
        jsonrpc: "2.0",
        method: "languages:clearDiagnostics",
        params: { extensionId: "ext.eslint", uri: "file:///x.ts" },
      })
    )
    expect(setDiagnosticsSpy).toHaveBeenCalledWith({
      extensionId: "ext.eslint",
      uri: "file:///x.ts",
      markers: [],
    })
  })
})
