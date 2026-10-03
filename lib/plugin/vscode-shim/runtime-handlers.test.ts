const secretLoad = jest.fn()
const secretSave = jest.fn()
const secretDelete = jest.fn()
const listPermissions = jest.fn()

jest.mock("@/lib/credentials/keyring-store", () => ({
  createKeyringStore: jest.fn(() => ({
    load: secretLoad,
    save: secretSave,
    delete: secretDelete,
  })),
}))

jest.mock("@/lib/plugin/core/transport", () => ({
  listPluginPermissions: (...args: unknown[]) => listPermissions(...args),
}))

const mockPlugins: Record<string, unknown> = {}
jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: { getState: () => ({ plugins: mockPlugins }) },
}))

// Every method the host sends is backed today, so the refusal path is
// exercised with a stand-in for one the host gains before the renderer does.
jest.mock("./unavailable-methods", () => ({
  EXPLICITLY_UNAVAILABLE_VSCODE_RPC_METHODS: ["fake:unbacked"],
}))

import {
  __resetCommandRegistryForTesting,
  executeCommand,
  getCommand,
  getCommands,
} from "@/lib/plugin/commands/registry"
import { __resetTaskRegistryForTesting, fetchTasks } from "@/lib/plugin/commands/tasks-registry"
import {
  __makeSession,
  __resetAuthRegistryForTesting,
  getProvider,
  registerAuthenticationProvider,
} from "@/lib/plugin/auth/auth-provider-registry"
import {
  AUTH_PROVIDER_WAIT_MS,
  EXPLICITLY_UNAVAILABLE_VSCODE_RPC_METHODS,
  cleanupVscodeRuntimeRegistrations,
  configureVscodeRuntimeActivationForTesting,
  configureVscodeRuntimeHandlersForTesting,
  installVscodeRuntimeRpcHandlers,
} from "./runtime-handlers"
import {
  configureRpcDispatcher,
  handleInboundFrame,
  listRegisteredMethods,
  resetRegistry,
} from "./rpc-dispatcher"

const responses: Array<{ pluginId: string; frame: Record<string, unknown> }> = []
const invokeSidecar = jest.fn()
let disposers: Array<() => void> = []

async function request(
  method: string,
  params: Record<string, unknown>,
  id = responses.length + 1,
  pluginId = "publisher.extension"
): Promise<Record<string, unknown>> {
  await handleInboundFrame(pluginId, JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  return responses.at(-1)?.frame ?? {}
}

describe("VS Code host-neutral runtime handlers", () => {
  beforeEach(() => {
    responses.length = 0
    resetRegistry()
    __resetCommandRegistryForTesting()
    __resetTaskRegistryForTesting()
    __resetAuthRegistryForTesting()
    jest.clearAllMocks()
    listPermissions.mockResolvedValue(["secrets:read", "secrets:write"])
    configureVscodeRuntimeHandlersForTesting(invokeSidecar)
    configureRpcDispatcher({
      listen: async () => () => {},
      // Three parameters, not two: the real `SendResponseFn` is
      // `(pluginId, generation, responseJson)`, so the two-parameter form was
      // JSON-parsing the generation string as if it were the frame.
      sendResponse: async (pluginId, _generation, raw) => {
        responses.push({ pluginId, frame: JSON.parse(raw) as Record<string, unknown> })
      },
    })
    disposers = installVscodeRuntimeRpcHandlers()
  })

  afterEach(() => {
    for (const dispose of disposers) dispose()
    cleanupVscodeRuntimeRegistrations("publisher.extension")
    configureVscodeRuntimeHandlersForTesting(null)
    configureRpcDispatcher(null)
    resetRegistry()
  })

  it("registers every implemented family and every explicit capability boundary", () => {
    const methods = listRegisteredMethods()
    expect(methods).toEqual(
      expect.arrayContaining([
        "commands:register",
        "commands:execute",
        "commands:list",
        "secrets:get",
        "secrets:store",
        "secrets:delete",
        "tasks:registerProvider",
        "tasks:fetchTasks",
        "authentication:registerProvider",
        "authentication:getSession",
        ...EXPLICITLY_UNAVAILABLE_VSCODE_RPC_METHODS,
      ])
    )
  })

  it("routes registered commands back to the owning sidecar callback", async () => {
    invokeSidecar.mockResolvedValue("done")
    const registered = await request("commands:register", {
      extensionId: "publisher.extension",
      command: "extension.run",
      token: "cmd-token",
    })
    expect(registered).toMatchObject({ result: { registered: true } })

    await expect(executeCommand("extension.run", 1, "two")).resolves.toBe("done")
    expect(invokeSidecar).toHaveBeenCalledWith("publisher.extension", "extension:call", {
      token: "cmd-token",
      payload: [1, "two"],
    })

    await request("commands:unregister", {
      extensionId: "publisher.extension",
      command: "extension.run",
    })
    expect(getCommands()).not.toContain("extension.run")
  })

  it("gives an extension's command the title, category and when its manifest contributes", async () => {
    mockPlugins["publisher.extension"] = {
      manifest: {
        vscodeExtension: {
          commands: [
            { command: "extension.run", title: "Run", category: "Ext", when: "editorFocus" },
          ],
        },
      },
    }
    try {
      await request("commands:register", {
        extensionId: "publisher.extension",
        command: "extension.run",
        token: "cmd-token",
      })
      expect(getCommand("extension.run")).toMatchObject({
        title: "Run",
        category: "Ext",
        when: "editorFocus",
      })
      await request("commands:register", {
        extensionId: "publisher.extension",
        command: "extension.other",
        token: "other-token",
      })
      expect(getCommand("extension.other")?.title).toBeUndefined()
    } finally {
      delete mockPlugins["publisher.extension"]
    }
  })

  it("starts the extension that provides an unregistered auth provider before asking it", async () => {
    const session = __makeSession({
      accessToken: "t",
      account: { id: "me", label: "Me" },
      scopes: [],
    })
    const activate = jest.fn(async (_event: string) => {
      registerAuthenticationProvider({
        id: "github",
        label: "GitHub",
        pluginId: "publisher.github",
        getSessions: async () => [session],
        createSession: async () => session,
        removeSession: async () => {},
      })
    })
    configureVscodeRuntimeActivationForTesting(activate)
    try {
      expect(
        await request("authentication:getSession", {
          extensionId: "publisher.extension",
          providerId: "github",
          scopes: [],
        })
      ).toMatchObject({ result: { id: session.id } })
      expect(activate).toHaveBeenCalledWith("onAuthenticationRequest:github")
      // Registered now: nothing more to start.
      await request("authentication:getAccounts", {
        extensionId: "publisher.extension",
        providerId: "github",
      })
      expect(activate).toHaveBeenCalledTimes(1)
    } finally {
      configureVscodeRuntimeActivationForTesting(null)
    }
  })

  it("reports a provider nobody registers once the wait is over", async () => {
    jest.useFakeTimers()
    const activate = jest.fn(async () => {})
    configureVscodeRuntimeActivationForTesting(activate)
    try {
      const pending = request("authentication:getSession", {
        extensionId: "publisher.extension",
        providerId: "nobody",
        scopes: [],
      })
      await jest.advanceTimersByTimeAsync(AUTH_PROVIDER_WAIT_MS)
      expect(await pending).toMatchObject({
        error: { message: expect.stringContaining('No auth provider registered for id "nobody"') },
      })
      expect(activate).toHaveBeenCalledWith("onAuthenticationRequest:nobody")
    } finally {
      configureVscodeRuntimeActivationForTesting(null)
      jest.useRealTimers()
    }
  })

  it("uses the canonical permission ledger and namespaced keyring for secrets", async () => {
    secretLoad.mockResolvedValue("secret-value")
    expect(
      await request("secrets:get", {
        extensionId: "publisher.extension",
        key: "token",
      })
    ).toMatchObject({ result: "secret-value" })
    expect(listPermissions).toHaveBeenCalledWith("publisher.extension")
    expect(secretLoad).toHaveBeenCalledWith("token")

    await request("secrets:store", {
      extensionId: "publisher.extension",
      key: "token",
      value: "next",
    })
    expect(secretSave).toHaveBeenCalledWith("token", "next")

    listPermissions.mockResolvedValueOnce([])
    expect(
      await request("secrets:delete", {
        extensionId: "publisher.extension",
        key: "token",
      })
    ).toMatchObject({ error: { code: -32000 } })
    expect(secretDelete).not.toHaveBeenCalled()
  })

  it("registers task and authentication providers through their existing registries", async () => {
    invokeSidecar.mockResolvedValueOnce([
      {
        id: "task.one",
        name: "One",
        source: "demo",
        definition: { type: "demo" },
      },
    ])
    await request("tasks:registerProvider", {
      extensionId: "publisher.extension",
      type: "demo",
      tokens: { provideTasks: "provide-token" },
    })
    await expect(fetchTasks({ type: "demo" })).resolves.toHaveLength(1)

    await request("authentication:registerProvider", {
      extensionId: "publisher.extension",
      providerId: "demo-auth",
      label: "Demo",
      tokens: {
        getSessions: "get-token",
        createSession: "create-token",
        removeSession: "remove-token",
      },
    })
    expect(getProvider("demo-auth")?.pluginId).toBe("publisher.extension")

    cleanupVscodeRuntimeRegistrations("publisher.extension")
    await expect(fetchTasks({ type: "demo" })).resolves.toEqual([])
    expect(getProvider("demo-auth")).toBeUndefined()
  })

  it("rejects spoofed extension ownership and unavailable requests immediately", async () => {
    expect(
      await request("commands:register", {
        extensionId: "publisher.attacker",
        command: "bad.run",
        token: "bad-token",
      })
    ).toMatchObject({ error: { code: -32000 } })

    const unavailable = await request("fake:unbacked", {
      extensionId: "publisher.extension",
    })
    expect(unavailable).toMatchObject({
      error: {
        code: -32000,
        message: expect.stringContaining("no canonical headless Cognia capability adapter"),
      },
    })
  })
})
