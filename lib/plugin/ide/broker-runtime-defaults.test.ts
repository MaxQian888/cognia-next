jest.mock("@/lib/codeserver/client", () => ({
  CODESERVER_EVENTS: {
    brokerRequest: "codeserver://broker-request",
    brokerNotification: "codeserver://broker-notification",
    instanceExited: "codeserver://instance-exited",
  },
  codeServerClient: {
    validateBrokerPaths: jest.fn(async (_root: string, paths: string[]) => paths),
    createBrokerContent: jest.fn(async () => ({ $type: "ContentHandle", id: "created" })),
    redeemBrokerContent: jest.fn(async () => [1, 2, 3]),
    respondToBroker: jest.fn(async () => undefined),
  },
}))
jest.mock("@/lib/db/trusted-workspaces", () => ({
  isWorkspaceTrusted: jest.fn(async () => true),
}))
jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: jest.fn(() => ({
    invokeIdeProvider: jest.fn(async () => "provider-result"),
  })),
}))
jest.mock("@/lib/plugin/core/transport", () => ({
  invokePluginApi: jest.fn(async () => "storage-result"),
}))
jest.mock("@/lib/plugin/security/consent-broker", () => ({
  getPluginConsentBroker: jest.fn(() => ({
    request: jest.fn(async () => true),
  })),
}))
jest.mock("@/lib/plugin/security/permission-guard", () => ({
  getPermissionGuard: jest.fn(() => ({
    require: jest.fn(),
  })),
}))
jest.mock("@/lib/tauri/events", () => ({
  onTauriEvent: jest.fn(),
}))
jest.mock("@/stores/plugin-runtime/plugin-store", () => ({
  usePluginStore: {
    getState: jest.fn(() => ({ plugins: { "acme.tools": { status: "enabled" } } })),
  },
}))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: {
    getState: jest.fn(() => ({ activeAccountId: "account-store" })),
  },
}))
jest.mock("@/lib/plugin/agent-sdk/dispatch", () => ({
  dispatchSubagent: jest.fn(async () => ({ runId: "run-1" })),
}))
jest.mock("./protocol-runtime", () => ({
  ManagedProtocolRuntime: jest.fn().mockImplementation(() => ({
    start: jest.fn(async () => ({ sessionId: "session" })),
    request: jest.fn(async () => ({ response: true })),
    cancel: jest.fn(async () => true),
    document: jest.fn(async () => undefined),
    stop: jest.fn(async () => undefined),
  })),
}))

import { CODESERVER_EVENTS, codeServerClient } from "@/lib/codeserver/client"
import { isWorkspaceTrusted } from "@/lib/db/trusted-workspaces"
import { dispatchSubagent } from "@/lib/plugin/agent-sdk/dispatch"
import { getPluginManager } from "@/lib/plugin/core/manager"
import { invokePluginApi } from "@/lib/plugin/core/transport"
import { getPluginConsentBroker } from "@/lib/plugin/security/consent-broker"
import { getPermissionGuard } from "@/lib/plugin/security/permission-guard"
import { onTauriEvent } from "@/lib/tauri/events"
import { useAccountStore } from "@/stores/account/account-store"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"

import {
  attachManagedIdeBroker,
  createManagedIdeBrokerDependencies,
  ManagedIdeBrokerRuntime,
  setManagedIdePermissionSimulator,
} from "./broker-runtime"
import { ManagedProtocolRuntime } from "./protocol-runtime"

describe("managed IDE broker default dependencies", () => {
  const originalAccountId = process.env.COGNIA_ACCOUNT_ID

  afterEach(() => {
    jest.clearAllMocks()
    setManagedIdePermissionSimulator(undefined)
    if (originalAccountId === undefined) {
      delete process.env.COGNIA_ACCOUNT_ID
    } else {
      process.env.COGNIA_ACCOUNT_ID = originalAccountId
    }
  })

  it("delegates host, content, permission, provider, protocol, and storage operations", async () => {
    const dependencies = createManagedIdeBrokerDependencies()
    const scope = {
      userId: "account",
      hostId: "local",
      workspaceRoot: "/work/project",
      area: "workspace" as const,
    }

    expect(dependencies.getPlugin("acme.tools")).toEqual({ status: "enabled" })
    await expect(dependencies.isWorkspaceTrusted("/work/project")).resolves.toBe(true)
    await expect(
      dependencies.validatePaths("/work/project", ["/work/project/main.ts"])
    ).resolves.toEqual(["/work/project/main.ts"])
    await expect(
      dependencies.createContent(
        "/work/project",
        2,
        "acme.tools",
        "cognia.acme.tools.hover",
        "editor:read",
        Uint8Array.from([4, 5])
      )
    ).resolves.toEqual({ $type: "ContentHandle", id: "created" })
    await expect(
      dependencies.redeemContent(
        "/work/project",
        2,
        "acme.tools",
        "cognia.acme.tools.hover",
        "editor:read",
        "handle"
      )
    ).resolves.toEqual(Uint8Array.from([1, 2, 3]))

    await expect(dependencies.authorize("acme.tools", "editor:read", "read editor")).resolves.toBe(
      true
    )
    await expect(
      dependencies.authorize("acme.tools", "process:spawn", "start server")
    ).resolves.toBe(true)
    dependencies.requirePermission("acme.tools", "editor:read", "read editor")
    expect(getPermissionGuard).toHaveBeenCalled()
    expect(getPluginConsentBroker).toHaveBeenCalled()

    await expect(dependencies.invoke("acme.tools", "provideHover", ["provide"])).resolves.toBe(
      "provider-result"
    )
    expect(
      jest.mocked(getPluginManager).mock.results[0].value.invokeIdeProvider
    ).toHaveBeenCalledWith("acme.tools", "provideHover", ["provide"])

    const onEvent = jest.fn()
    const requestApproval = jest.fn(async () => ({ behavior: "allow" as const }))
    await expect(
      dependencies.invokeAgent("researcher", "inspect", {
        signal: new AbortController().signal,
        onEvent,
        requestApproval,
      })
    ).resolves.toEqual({ result: { metadata: { runId: "run-1" } } })
    expect(dispatchSubagent).toHaveBeenCalledWith(
      "researcher",
      "inspect",
      expect.objectContaining({
        abortSignal: expect.any(AbortSignal),
        _onEvent: onEvent,
        _canUseTool: expect.any(Function),
      })
    )
    const agentOptions = jest.mocked(dispatchSubagent).mock.calls[0][2]
    if (!agentOptions?._canUseTool) throw new Error("permission callback was not forwarded")
    await expect(agentOptions._canUseTool("Bash", { command: "pwd" }, {})).resolves.toEqual({
      behavior: "allow",
    })

    const protocols = jest.mocked(ManagedProtocolRuntime).mock.results[0].value
    const protocolInput = { root: "/work/project" } as never
    await dependencies.protocolStart(protocolInput)
    await dependencies.protocolRequest(protocolInput)
    await dependencies.protocolCancel(protocolInput)
    await dependencies.protocolDocument(protocolInput)
    await dependencies.protocolStop(protocolInput)
    expect(protocols.start).toHaveBeenCalledWith(protocolInput)
    expect(protocols.request).toHaveBeenCalledWith(protocolInput)
    expect(protocols.cancel).toHaveBeenCalledWith(protocolInput)
    expect(protocols.document).toHaveBeenCalledWith(protocolInput)
    expect(protocols.stop).toHaveBeenCalledWith(protocolInput)

    await dependencies.stateGet("acme.tools", scope, "key")
    await dependencies.stateSet("acme.tools", scope, "key", { enabled: true })
    await dependencies.stateDelete("acme.tools", scope, "key")
    await dependencies.stateKeys("acme.tools", scope)
    await dependencies.secretGet("acme.tools", scope, "secret")
    await dependencies.secretSet("acme.tools", scope, "secret", "value")
    await dependencies.secretDelete("acme.tools", scope, "secret")
    await dependencies.secretKeys("acme.tools", scope)
    expect(invokePluginApi).toHaveBeenCalledTimes(8)
    expect(dependencies.now()).toEqual(expect.any(Number))
    expect(isWorkspaceTrusted).toHaveBeenCalledWith("/work/project")
    expect(codeServerClient.createBrokerContent).toHaveBeenCalledWith(
      "/work/project",
      2,
      "acme.tools",
      "cognia.acme.tools.hover",
      "editor:read",
      "application/octet-stream",
      [4, 5]
    )
    expect(usePluginStore.getState).toHaveBeenCalled()
  })

  it("honors permission simulation and resolves the configured account partition", async () => {
    const dependencies = createManagedIdeBrokerDependencies()
    setManagedIdePermissionSimulator(({ permission }) =>
      permission === "process:spawn" ? false : undefined
    )
    await expect(
      dependencies.authorize("acme.tools", "process:spawn", "start server")
    ).resolves.toBe(false)
    expect(getPermissionGuard).not.toHaveBeenCalled()

    process.env.COGNIA_ACCOUNT_ID = "environment-account"
    expect(dependencies.getUserId()).toBe("environment-account")
    delete process.env.COGNIA_ACCOUNT_ID
    expect(dependencies.getUserId()).toBe("account-store")
    jest.mocked(useAccountStore.getState).mockReturnValueOnce({ activeAccountId: null } as never)
    expect(dependencies.getUserId()).toBe("local-default")
  })

  it("forbids permission simulation in production", () => {
    const nodeEnv = jest.replaceProperty(process.env, "NODE_ENV", "production")
    try {
      expect(() => setManagedIdePermissionSimulator(() => true)).toThrow(
        "IDE_PERMISSION_SIMULATION_PRODUCTION_FORBIDDEN"
      )
    } finally {
      nodeEnv.restore()
    }
  })

  it("adapts Tauri broker events and releases listeners", async () => {
    const handlers = new Map<string, (payload: unknown) => void>()
    const unlisteners = [jest.fn(), jest.fn(), jest.fn()]
    let listenerIndex = 0
    jest.mocked(onTauriEvent).mockImplementation(async (event, handler) => {
      handlers.set(event, handler as (payload: unknown) => void)
      return unlisteners[listenerIndex++]
    })
    const dispatch = jest
      .fn()
      .mockResolvedValueOnce("ok")
      .mockRejectedValueOnce(new Error("dispatch failed"))
    const cancel = jest.fn()
    const disconnect = jest.fn()
    const runtime = { dispatch, cancel, disconnect } as unknown as ManagedIdeBrokerRuntime
    const dispose = await attachManagedIdeBroker(runtime)
    const request = {
      root: "/work/project",
      generation: 3,
      id: "request",
      method: "cognia/provider/invoke",
      params: {},
    }

    handlers.get(CODESERVER_EVENTS.brokerRequest)?.(request)
    handlers.get(CODESERVER_EVENTS.brokerRequest)?.({ ...request, id: "failed" })
    handlers.get(CODESERVER_EVENTS.brokerNotification)?.({
      root: "/work/project",
      generation: 3,
      method: "cognia/provider/cancel",
      params: {},
    })
    handlers.get(CODESERVER_EVENTS.instanceExited)?.({ root: "/work/project" })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(codeServerClient.respondToBroker).toHaveBeenNthCalledWith(1, request, {
      result: "ok",
    })
    expect(codeServerClient.respondToBroker).toHaveBeenNthCalledWith(
      2,
      { ...request, id: "failed" },
      {
        error: expect.objectContaining({ code: -32603, message: "dispatch failed" }),
      }
    )
    expect(cancel).toHaveBeenCalled()
    expect(disconnect).toHaveBeenCalledWith("/work/project")
    dispose()
    for (const unlisten of unlisteners) expect(unlisten).toHaveBeenCalledTimes(1)
  })
})
