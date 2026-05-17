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
})
