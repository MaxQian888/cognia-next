import {
  CODESERVER_EVENTS,
  codeServerClient,
  type CodeServerBrokerNotification,
  type CodeServerBrokerRequest,
} from "@/lib/codeserver/client"
import type { Plugin, PluginPermission } from "@/types/plugin"

import { IDE_CAPABILITY_CATALOG } from "./catalog"
import {
  attachManagedIdeBrokerTransport,
  clearManagedIdeRpcTraces,
  getManagedIdeRpcTraces,
  hashIdeManifest,
  ManagedIdeBrokerRuntime,
  type ManagedIdeBrokerDependencies,
} from "./broker-runtime"
import { normalizeIdeManifest } from "./manifest"

const ROOT = "/work/project"

describe("ManagedIdeBrokerRuntime", () => {
  afterEach(() => {
    jest.restoreAllMocks()
    clearManagedIdeRpcTraces()
  })

  it("revalidates manifest, workspace, permission and provider before invoking", async () => {
    clearManagedIdeRpcTraces()
    const plugin = makePlugin("editor:read")
    const invoke = jest.fn(async () => ({ contents: "hover" }))
    const authorize = jest.fn(async () => true)
    const validatePaths = jest.fn(async (_root: string, paths: string[]) => paths)
    const runtime = new ManagedIdeBrokerRuntime(
      dependencies(plugin, { invoke, authorize, validatePaths })
    )

    await expect(runtime.dispatch(await request(plugin))).resolves.toEqual({
      contents: "hover",
    })
    expect(authorize).toHaveBeenCalledWith("acme.tools", "editor:read", "Managed IDE hover:provide")
    expect(validatePaths).toHaveBeenCalledWith(ROOT, [`${ROOT}/main.ts`])
    expect(invoke).toHaveBeenCalledWith("acme.tools", "provideHover", [
      "provide",
      { uri: "file:///work/project/main.ts" },
    ])
    expect(getManagedIdeRpcTraces()).toEqual([
      expect.objectContaining({
        pluginId: "acme.tools",
        providerId: "cognia.acme.tools.hover",
        operation: "provide",
        outcome: "success",
      }),
    ])
    expect(JSON.stringify(getManagedIdeRpcTraces())).not.toContain("main.ts")
  })

  it("fails closed for disabled plugins, untrusted workspaces and forged providers", async () => {
    const disabled = makePlugin("editor:read")
    disabled.status = "disabled"
    const disabledRuntime = new ManagedIdeBrokerRuntime(dependencies(disabled))
    await expect(disabledRuntime.dispatch(await request(disabled))).rejects.toThrow(
      "IDE_PLUGIN_NOT_ACTIVE"
    )

    const plugin = makePlugin("editor:read")
    const untrustedRuntime = new ManagedIdeBrokerRuntime(
      dependencies(plugin, { isWorkspaceTrusted: async () => false })
    )
    await expect(untrustedRuntime.dispatch(await request(plugin))).rejects.toThrow(
      "IDE_WORKSPACE_UNTRUSTED"
    )
    const codeUntrusted = await request(plugin)
    ;(codeUntrusted.params as { workspaceTrusted: boolean }).workspaceTrusted = false
    await expect(
      new ManagedIdeBrokerRuntime(dependencies(plugin)).dispatch(codeUntrusted)
    ).rejects.toThrow("IDE_WORKSPACE_UNTRUSTED")

    const forged = await request(plugin)
    ;(forged.params as { providerId: string }).providerId = "cognia.acme.tools.forged"
    const runtime = new ManagedIdeBrokerRuntime(dependencies(plugin))
    await expect(runtime.dispatch(forged)).rejects.toThrow("IDE_PROVIDER_NOT_DECLARED")
  })

  it("rejects provider file arguments that the IDE host cannot confine", async () => {
    const plugin = makePlugin("editor:read")
    const invoke = jest.fn(async () => "must not run")
    const runtime = new ManagedIdeBrokerRuntime(
      dependencies(plugin, {
        invoke,
        validatePaths: async () => {
          throw new Error("path escapes the allowed roots")
        },
      })
    )

    const escaped = await request(plugin)
    ;(escaped.params as { arguments: unknown[] }).arguments = [
      { uri: "file:///work/project/../../etc/passwd" },
    ]
    await expect(runtime.dispatch(escaped)).rejects.toThrow("path escapes the allowed roots")
    expect(invoke).not.toHaveBeenCalled()
  })

  it("redeems and returns scoped one-shot content handles outside broker JSON", async () => {
    const plugin = makePlugin("editor:read")
    const redeemContent = jest.fn(async () => Uint8Array.from([1, 2, 3]))
    const createContent = jest.fn(async () => ({
      $type: "ContentHandle",
      id: "out",
      size: 2,
    }))
    const invoke = jest.fn(async (_pluginId, _handler, args: unknown[]) => {
      expect(args[1]).toEqual(Uint8Array.from([1, 2, 3]))
      return Uint8Array.from([4, 5])
    })
    const runtime = new ManagedIdeBrokerRuntime(
      dependencies(plugin, { redeemContent, createContent, invoke })
    )
    const binaryRequest = await request(plugin)
    ;(binaryRequest.params as { arguments: unknown[] }).arguments = [
      { $type: "ContentHandle", id: "in", size: 3 },
    ]

    await expect(runtime.dispatch(binaryRequest)).resolves.toMatchObject({
      $type: "ContentHandle",
      id: "out",
    })
    expect(redeemContent).toHaveBeenCalledWith(
      ROOT,
      1,
      "acme.tools",
      "cognia.acme.tools.hover",
      "editor:read",
      "in"
    )
    expect(createContent).toHaveBeenCalledWith(
      ROOT,
      1,
      "acme.tools",
      "cognia.acme.tools.hover",
      "editor:read",
      Uint8Array.from([4, 5])
    )
  })

  it("rejects stale connection generations and mismatched manifest hashes", async () => {
    const plugin = makePlugin("editor:read")
    const runtime = new ManagedIdeBrokerRuntime(dependencies(plugin))
    await runtime.dispatch(await request(plugin, 4))

    await expect(runtime.dispatch(await request(plugin, 3))).rejects.toThrow("IDE_STALE_GENERATION")
    const forged = await request(plugin, 4)
    ;(forged.params as { manifestHash: string }).manifestHash = "sha256:forged"
    await expect(runtime.dispatch(forged)).rejects.toThrow("IDE_MANIFEST_HASH_MISMATCH")
  })

  it("rejects forged provider workspace, host, version, and catalog scopes", async () => {
    const plugin = makePlugin("editor:read")
    const runtime = new ManagedIdeBrokerRuntime(dependencies(plugin))
    const cases: Array<{
      field: "workspaceRoot" | "hostId" | "pluginVersion" | "catalogHash"
      value: string
      error: string
    }> = [
      {
        field: "workspaceRoot",
        value: "/work/other",
        error: "IDE_WORKSPACE_SCOPE_MISMATCH",
      },
      { field: "hostId", value: "remote", error: "IDE_HOST_SCOPE_MISMATCH" },
      { field: "pluginVersion", value: "2.0.0", error: "IDE_PLUGIN_VERSION_MISMATCH" },
      { field: "catalogHash", value: "sha256:forged", error: "IDE_CATALOG_MISMATCH" },
    ]

    for (const [index, testCase] of cases.entries()) {
      const forged = await request(plugin, 1, `forged-scope-${index}`)
      ;(
        forged.params as Record<
          "workspaceRoot" | "hostId" | "pluginVersion" | "catalogHash",
          string
        >
      )[testCase.field] = testCase.value
      await expect(runtime.dispatch(forged)).rejects.toThrow(testCase.error)
    }
  })

  it("stores managed extension state in the Cognia host partition", async () => {
    const plugin = makePlugin("editor:read")
    const stateSet = jest.fn(async () => undefined)
    const stateKeys = jest.fn(async () => ["selection"])
    const runtime = new ManagedIdeBrokerRuntime(dependencies(plugin, { stateSet, stateKeys }))

    await expect(
      runtime.dispatch(
        await storageRequest(plugin, "cognia/state/set", {
          area: "workspace",
          key: "selection",
          value: { line: 7 },
        })
      )
    ).resolves.toBeNull()
    await expect(
      runtime.dispatch(
        await storageRequest(plugin, "cognia/state/keys", {
          area: "workspace",
        })
      )
    ).resolves.toEqual(["selection"])
    expect(stateSet).toHaveBeenCalledWith(
      "acme.tools",
      {
        userId: "acct_test",
        hostId: "local",
        workspaceRoot: ROOT,
        area: "workspace",
      },
      "selection",
      { line: 7 }
    )
  })

  it("routes every managed state and secret operation through the Cognia host", async () => {
    const plugin = makePlugin("editor:read")
    plugin.manifest.permissions = ["editor:read", "secrets:read", "secrets:write"]
    const stateGet = jest.fn(async () => ({ line: 7 }))
    const stateDelete = jest.fn(async () => undefined)
    const secretSet = jest.fn(async () => undefined)
    const secretDelete = jest.fn(async () => undefined)
    const secretKeys = jest.fn(async () => ["api-key"])
    const runtime = new ManagedIdeBrokerRuntime(
      dependencies(plugin, {
        stateGet,
        stateDelete,
        secretSet,
        secretDelete,
        secretKeys,
      })
    )

    await expect(
      runtime.dispatch(
        await storageRequest(plugin, "cognia/state/get", {
          area: "global",
          key: "selection",
        })
      )
    ).resolves.toEqual({ line: 7 })
    await expect(
      runtime.dispatch(
        await storageRequest(plugin, "cognia/state/delete", {
          area: "global",
          key: "selection",
        })
      )
    ).resolves.toBeNull()
    await expect(
      runtime.dispatch(
        await storageRequest(plugin, "cognia/secrets/set", {
          area: "workspace",
          key: "api-key",
          value: "secret",
        })
      )
    ).resolves.toBeNull()
    await expect(
      runtime.dispatch(
        await storageRequest(plugin, "cognia/secrets/delete", {
          area: "workspace",
          key: "api-key",
        })
      )
    ).resolves.toBeNull()
    await expect(
      runtime.dispatch(
        await storageRequest(plugin, "cognia/secrets/keys", {
          area: "workspace",
        })
      )
    ).resolves.toEqual(["api-key"])

    expect(stateGet).toHaveBeenCalledWith(
      "acme.tools",
      expect.objectContaining({ area: "global" }),
      "selection"
    )
    expect(stateDelete).toHaveBeenCalledWith(
      "acme.tools",
      expect.objectContaining({ area: "global" }),
      "selection"
    )
    expect(secretSet).toHaveBeenCalledWith(
      "acme.tools",
      expect.objectContaining({ area: "secrets" }),
      "api-key",
      "secret"
    )
    expect(secretDelete).toHaveBeenCalledWith(
      "acme.tools",
      expect.objectContaining({ area: "secrets" }),
      "api-key"
    )
    expect(secretKeys).toHaveBeenCalledWith(
      "acme.tools",
      expect.objectContaining({ area: "secrets" })
    )
  })

  it("rejects malformed storage values and unavailable user partitions", async () => {
    const plugin = makePlugin("secrets:write")
    const runtime = new ManagedIdeBrokerRuntime(dependencies(plugin))
    const invalidSecret = await storageRequest(plugin, "cognia/secrets/set", {
      area: "global",
      key: "api-key",
      value: 7,
    })
    await expect(runtime.dispatch(invalidSecret)).rejects.toThrow("IDE_SECRET_VALUE_INVALID")

    const invalidKey = await storageRequest(plugin, "cognia/secrets/delete", {
      area: "global",
      key: "bad\0key",
    })
    await expect(runtime.dispatch(invalidKey)).rejects.toThrow("IDE_STORAGE_KEY_INVALID")

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const invalidState = await storageRequest(plugin, "cognia/state/set", {
      area: "workspace",
      key: "cyclic",
      value: cyclic,
    })
    await expect(runtime.dispatch(invalidState)).rejects.toThrow("IDE_STORAGE_VALUE_INVALID")

    const noUserRuntime = new ManagedIdeBrokerRuntime(dependencies(plugin, { getUserId: () => "" }))
    await expect(
      noUserRuntime.dispatch(await storageRequest(plugin, "cognia/state/keys", { area: "global" }))
    ).rejects.toThrow("IDE_USER_SCOPE_UNAVAILABLE")
  })

  it("validates every managed-storage boundary before touching host state", async () => {
    const plugin = makePlugin("editor:read")
    const stateGet = jest.fn()
    const runtime = new ManagedIdeBrokerRuntime(dependencies(plugin, { stateGet }))
    for (const params of [null, []]) {
      await expect(
        runtime.dispatch({
          root: ROOT,
          generation: 1,
          id: "invalid-storage",
          method: "cognia/state/get",
          params,
        })
      ).rejects.toThrow("IDE_STORAGE_PARAMS_INVALID")
    }

    const missingPlugin = await storageRequest(plugin, "cognia/state/keys", { area: "global" })
    ;(missingPlugin.params as { pluginId: string }).pluginId = ""
    await expect(runtime.dispatch(missingPlugin)).rejects.toThrow("IDE_STORAGE_PARAMS_INVALID")

    const invalidArea = await storageRequest(plugin, "cognia/state/keys", { area: "global" })
    ;(invalidArea.params as { area: unknown }).area = "secret"
    await expect(runtime.dispatch(invalidArea)).rejects.toThrow("IDE_STORAGE_PARAMS_INVALID")

    const invalidTrust = await storageRequest(plugin, "cognia/state/keys", { area: "global" })
    ;(invalidTrust.params as { workspaceTrusted: unknown }).workspaceTrusted = 1
    await expect(runtime.dispatch(invalidTrust)).rejects.toThrow("IDE_STORAGE_PARAMS_INVALID")

    const unknownOperation = await storageRequest(plugin, "cognia/state/keys", { area: "global" })
    unknownOperation.method = "cognia/state/purge"
    await expect(runtime.dispatch(unknownOperation)).rejects.toThrow("IDE_BROKER_METHOD_NOT_FOUND")

    for (const key of [undefined, "", "x".repeat(1025)]) {
      const invalidKey = await storageRequest(plugin, "cognia/state/get", {
        area: "global",
        ...(key === undefined ? {} : { key }),
      })
      await expect(runtime.dispatch(invalidKey)).rejects.toThrow("IDE_STORAGE_KEY_INVALID")
    }

    const missingValue = await storageRequest(plugin, "cognia/state/set", {
      area: "global",
      key: "selection",
    })
    await expect(runtime.dispatch(missingValue)).rejects.toThrow("IDE_STORAGE_VALUE_INVALID")
    const undefinedValue = await storageRequest(plugin, "cognia/state/set", {
      area: "global",
      key: "selection",
      value: undefined,
    })
    await expect(runtime.dispatch(undefinedValue)).rejects.toThrow("IDE_STORAGE_VALUE_INVALID")
    expect(stateGet).not.toHaveBeenCalled()
  })

  it("rejects forged managed-storage workspace, version, and catalog scopes", async () => {
    const plugin = makePlugin("editor:read")
    const runtime = new ManagedIdeBrokerRuntime(dependencies(plugin))
    const cases: Array<{
      field: "workspaceRoot" | "pluginVersion" | "catalogHash"
      value: string
      error: string
    }> = [
      {
        field: "workspaceRoot",
        value: "/work/other",
        error: "IDE_WORKSPACE_SCOPE_MISMATCH",
      },
      { field: "pluginVersion", value: "2.0.0", error: "IDE_PLUGIN_VERSION_MISMATCH" },
      { field: "catalogHash", value: "sha256:forged", error: "IDE_CATALOG_MISMATCH" },
    ]

    for (const testCase of cases) {
      const forged = await storageRequest(plugin, "cognia/state/keys", { area: "global" })
      ;(forged.params as Record<"workspaceRoot" | "pluginVersion" | "catalogHash", string>)[
        testCase.field
      ] = testCase.value
      await expect(runtime.dispatch(forged)).rejects.toThrow(testCase.error)
    }
  })

  it("rechecks secret permissions and rejects forged storage scopes", async () => {
    const plugin = makePlugin("secrets:read")
    const secretGet = jest.fn(async () => "token")
    const requirePermission = jest.fn()
    const runtime = new ManagedIdeBrokerRuntime(
      dependencies(plugin, { secretGet, requirePermission })
    )
    await expect(
      runtime.dispatch(
        await storageRequest(plugin, "cognia/secrets/get", {
          area: "global",
          key: "api-key",
        })
      )
    ).resolves.toBe("token")
    expect(requirePermission).toHaveBeenCalledWith(
      "acme.tools",
      "secrets:read",
      "Managed IDE secret storage get"
    )
    expect(secretGet).toHaveBeenCalledWith(
      "acme.tools",
      expect.objectContaining({
        userId: "acct_test",
        workspaceRoot: ROOT,
        area: "secrets",
      }),
      "api-key"
    )

    const forged = await storageRequest(plugin, "cognia/secrets/get", {
      area: "global",
      key: "api-key",
    })
    ;(forged.params as { hostId: string }).hostId = "other-host"
    await expect(runtime.dispatch(forged)).rejects.toThrow("IDE_HOST_SCOPE_MISMATCH")

    const missingPermission = makePlugin("editor:read")
    await expect(
      new ManagedIdeBrokerRuntime(dependencies(missingPermission)).dispatch(
        await storageRequest(missingPermission, "cognia/secrets/get", {
          area: "global",
          key: "api-key",
        })
      )
    ).rejects.toThrow("IDE_PERMISSION_NOT_DECLARED")

    const untrusted = makePlugin("editor:read")
    await expect(
      new ManagedIdeBrokerRuntime(
        dependencies(untrusted, { isWorkspaceTrusted: async () => false })
      ).dispatch(await storageRequest(untrusted, "cognia/state/keys", { area: "global" }))
    ).rejects.toThrow("IDE_WORKSPACE_UNTRUSTED")

    const disabled = makePlugin("editor:read")
    disabled.status = "disabled"
    await expect(
      new ManagedIdeBrokerRuntime(dependencies(disabled)).dispatch(
        await storageRequest(disabled, "cognia/state/keys", { area: "global" })
      )
    ).rejects.toThrow("IDE_PLUGIN_NOT_ACTIVE")

    const forgedHash = await storageRequest(untrusted, "cognia/state/keys", { area: "global" })
    ;(forgedHash.params as { manifestHash: string }).manifestHash = "sha256:forged"
    await expect(
      new ManagedIdeBrokerRuntime(dependencies(untrusted)).dispatch(forgedHash)
    ).rejects.toThrow("IDE_MANIFEST_HASH_MISMATCH")
  })

  it("retires pending provider invocations when a newer connection generation arrives", async () => {
    const plugin = makePlugin("editor:read")
    const invoke = jest
      .fn<Promise<unknown>, [string, string, unknown[]]>()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce("reconnected")
    const runtime = new ManagedIdeBrokerRuntime(dependencies(plugin, { invoke }))

    const previous = runtime.dispatch(await request(plugin, 4, "old-invocation"))
    const previousRejection = expect(previous).rejects.toThrow("IDE_CONNECTION_GENERATION_REPLACED")
    while (invoke.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    await expect(runtime.dispatch(await request(plugin, 5, "new-invocation"))).resolves.toBe(
      "reconnected"
    )
    await previousRejection
  })

  it("fails pending provider invocations when the broker disconnects", async () => {
    const plugin = makePlugin("editor:read")
    const invoke = jest.fn(() => new Promise<unknown>(() => undefined))
    const runtime = new ManagedIdeBrokerRuntime(dependencies(plugin, { invoke }))

    const pending = runtime.dispatch(await request(plugin, 8, "pending-disconnect"))
    while (invoke.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    runtime.disconnect(ROOT)

    await expect(pending).rejects.toThrow("IDE_BROKER_DISCONNECTED")
    await expect(
      runtime.emitProviderEvent({
        root: ROOT,
        pluginId: plugin.manifest.id,
        providerId: "cognia.acme.tools.hover",
        event: "change",
      })
    ).rejects.toThrow("IDE_BROKER_NOT_CONNECTED")
  })

  it("serializes write providers by workspace/provider key", async () => {
    const plugin = makePlugin("editor:write")
    let releaseFirst: (() => void) | undefined
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const invoke = jest
      .fn<Promise<unknown>, [string, string, unknown[]]>()
      .mockImplementationOnce(async () => first)
      .mockResolvedValueOnce("second")
    const runtime = new ManagedIdeBrokerRuntime(dependencies(plugin, { invoke }))

    const firstRun = runtime.dispatch(await request(plugin, 1, "write-1"))
    const secondRun = runtime.dispatch(await request(plugin, 1, "write-2"))
    while (invoke.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(invoke).toHaveBeenCalledTimes(1)
    releaseFirst?.()
    await firstRun
    await expect(secondRun).resolves.toBe("second")
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it("enforces provider deadlines, duplicate IDs, and permissionless binary results", async () => {
    const timed = makePlugin("editor:read")
    timed.manifest.ide!.providers![0].metadata = { timeoutMs: 1 }
    await expect(
      new ManagedIdeBrokerRuntime(
        dependencies(timed, { invoke: () => new Promise<unknown>(() => undefined) })
      ).dispatch(await request(timed, 1, "timed"))
    ).rejects.toThrow("IDE_PROVIDER_TIMEOUT")

    const noDeadline = makePlugin("editor:read")
    noDeadline.manifest.ide!.providers![0].metadata = { timeoutMs: 0 }
    await expect(
      new ManagedIdeBrokerRuntime(dependencies(noDeadline)).dispatch(
        await request(noDeadline, 1, "default-deadline")
      )
    ).resolves.toBe("ok")

    const duplicatePlugin = makePlugin("editor:read")
    const duplicateInvoke = jest.fn(() => new Promise<unknown>(() => undefined))
    const duplicateRuntime = new ManagedIdeBrokerRuntime(
      dependencies(duplicatePlugin, { invoke: duplicateInvoke })
    )
    const duplicateRequest = await request(duplicatePlugin, 2, "duplicate")
    const pending = duplicateRuntime.dispatch(duplicateRequest)
    while (duplicateInvoke.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    await expect(duplicateRuntime.dispatch(duplicateRequest)).rejects.toThrow(
      "IDE_DUPLICATE_INVOCATION_ID"
    )
    duplicateRuntime.cancel({
      root: ROOT,
      generation: 2,
      method: "cognia/provider/cancel",
      params: {
        invocationId: "duplicate",
        pluginId: "acme.tools",
        providerId: "cognia.acme.tools.hover",
        operation: "provide",
      },
    })
    await expect(pending).rejects.toThrow("IDE_PROVIDER_CANCELLED")

    const command = makeCommandPlugin()
    const createContent = jest.fn(async () => ({
      $type: "ContentHandle",
      id: "command-result",
    }))
    await expect(
      new ManagedIdeBrokerRuntime(
        dependencies(command, {
          invoke: async () => Uint8Array.from([1]),
          createContent,
        })
      ).dispatch(await request(command, 1, "command"))
    ).resolves.toEqual({ $type: "ContentHandle", id: "command-result" })
    expect(createContent).toHaveBeenCalledWith(
      ROOT,
      1,
      "acme.tools",
      "cognia.acme.tools.command",
      null,
      Uint8Array.from([1])
    )
  })

  it("cancels only the matching invocation in the current connection generation", async () => {
    const plugin = makePlugin("editor:read")
    const invoke = jest.fn(() => new Promise<unknown>(() => undefined))
    const runtime = new ManagedIdeBrokerRuntime(dependencies(plugin, { invoke }))
    const pendingRequest = await request(plugin, 7)
    const pending = runtime.dispatch(pendingRequest)
    while (invoke.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    expect(
      runtime.cancel({
        root: ROOT,
        generation: 7,
        method: "cognia/provider/cancel",
        params: {
          invocationId: "invoke-1",
          pluginId: "acme.tools",
          providerId: "cognia.acme.tools.hover",
          operation: "provide",
        },
      })
    ).toBe(true)
    await expect(pending).rejects.toThrow("IDE_PROVIDER_CANCELLED")

    expect(
      runtime.cancel({
        root: ROOT,
        generation: 6,
        method: "cognia/provider/cancel",
        params: {
          invocationId: "invoke-1",
          pluginId: "acme.tools",
          providerId: "cognia.acme.tools.hover",
          operation: "provide",
        },
      })
    ).toBe(false)
  })

  it("streams agent events and resolves native IDE tool approvals on the exact invocation", async () => {
    const plugin = makePlugin("editor:read")
    plugin.manifest.permissions = ["editor:read", "agent:control"]
    plugin.manifest.ide!.providers = []
    plugin.manifest.ide!.agents = [
      {
        id: "assistant",
        agentId: "researcher",
        name: "Researcher",
      },
    ]
    const notify = jest.spyOn(codeServerClient, "notifyBroker").mockResolvedValue()
    const invokeAgent: jest.MockedFunction<ManagedIdeBrokerDependencies["invokeAgent"]> = jest.fn(
      async (_agentId, _prompt, context) => {
        context.onEvent({ type: "text-delta", delta: "live" })
        const decision = await context.requestApproval("Bash", { command: "pwd" })
        return { decision }
      }
    )
    const runtime = new ManagedIdeBrokerRuntime(dependencies(plugin, { invokeAgent }))
    const agentRequest = await request(plugin, 12, "agent-invoke")
    ;(agentRequest.params as { arguments: unknown[] }).arguments = [{ prompt: "inspect" }]
    const pending = runtime.dispatch(agentRequest)

    while (!notify.mock.calls.some(([, , event]) => event.event === "approval")) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const approval = notify.mock.calls.find(([, , event]) => event.event === "approval")?.[2]
    expect(approval).toMatchObject({
      pluginId: "acme.tools",
      providerId: "cognia.acme.tools.assistant",
      invocationId: "agent-invoke",
      event: "approval",
      payload: {
        toolName: "Bash",
        input: { command: "pwd" },
      },
    })
    const requestId = (approval?.payload as { requestId: string }).requestId
    expect(
      runtime.cancel({
        root: ROOT,
        generation: 12,
        method: "cognia/provider/approvalResponse",
        params: {
          invocationId: "agent-invoke",
          requestId,
          pluginId: "acme.tools",
          providerId: "cognia.acme.tools.assistant",
          decision: "allow",
          updatedInput: { command: "pwd", approved: true },
        },
      })
    ).toBe(true)

    await expect(pending).resolves.toEqual({
      decision: {
        behavior: "allow",
        updatedInput: { command: "pwd", approved: true },
      },
    })
    expect(notify).toHaveBeenCalledWith(
      ROOT,
      12,
      expect.objectContaining({
        invocationId: "agent-invoke",
        event: "stream",
        payload: { type: "text-delta", delta: "live" },
      })
    )
  })

  it("rejects forged approval responses and cancels pending approvals with the invocation", async () => {
    const plugin = makePlugin("editor:read")
    plugin.manifest.permissions = ["editor:read", "agent:control"]
    plugin.manifest.ide!.providers = []
    plugin.manifest.ide!.agents = [
      {
        id: "assistant",
        agentId: "researcher",
        name: "Researcher",
      },
    ]
    const notify = jest.spyOn(codeServerClient, "notifyBroker").mockResolvedValue()
    const invokeAgent: jest.MockedFunction<ManagedIdeBrokerDependencies["invokeAgent"]> = jest.fn(
      async (_agentId, _prompt, context) => context.requestApproval("Write", { path: "a.ts" })
    )
    const runtime = new ManagedIdeBrokerRuntime(dependencies(plugin, { invokeAgent }))
    const agentRequest = await request(plugin, 13, "approval-cancel")
    ;(agentRequest.params as { arguments: unknown[] }).arguments = [{ prompt: "inspect" }]
    const pending = runtime.dispatch(agentRequest)
    while (!notify.mock.calls.some(([, , event]) => event.event === "approval")) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const approval = notify.mock.calls.find(([, , event]) => event.event === "approval")?.[2]
    const requestId = (approval?.payload as { requestId: string }).requestId

    expect(
      runtime.cancel({
        root: ROOT,
        generation: 13,
        method: "cognia/provider/approvalResponse",
        params: {
          invocationId: "approval-cancel",
          requestId,
          pluginId: "forged.plugin",
          providerId: "cognia.acme.tools.assistant",
          decision: "allow",
        },
      })
    ).toBe(false)
    expect(
      runtime.cancel({
        root: ROOT,
        generation: 13,
        method: "cognia/provider/cancel",
        params: {
          invocationId: "approval-cancel",
          pluginId: "acme.tools",
          providerId: "cognia.acme.tools.assistant",
          operation: "provide",
        },
      })
    ).toBe(true)
    await expect(pending).rejects.toThrow("IDE_PROVIDER_CANCELLED")
  })

  it("resolves denied agent approvals with the native IDE default explanation", async () => {
    const plugin = makeAgentPlugin()
    const notify = jest.spyOn(codeServerClient, "notifyBroker").mockResolvedValue()
    const invokeAgent: jest.MockedFunction<ManagedIdeBrokerDependencies["invokeAgent"]> = jest.fn(
      async (_agentId, _prompt, context) => context.requestApproval("Write", { path: "a.ts" })
    )
    const runtime = new ManagedIdeBrokerRuntime(dependencies(plugin, { invokeAgent }))
    const agentRequest = await request(plugin, 14, "approval-deny")
    ;(agentRequest.params as { arguments: unknown[] }).arguments = [{ prompt: "inspect" }]
    const pending = runtime.dispatch(agentRequest)
    while (!notify.mock.calls.some(([, , event]) => event.event === "approval")) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const approval = notify.mock.calls.find(([, , event]) => event.event === "approval")?.[2]
    const requestId = (approval?.payload as { requestId: string }).requestId

    expect(
      runtime.cancel({
        root: ROOT,
        generation: 14,
        method: "cognia/provider/approvalResponse",
        params: {
          invocationId: "approval-deny",
          requestId,
          pluginId: "acme.tools",
          providerId: "cognia.acme.tools.assistant",
          decision: "deny",
        },
      })
    ).toBe(true)
    await expect(pending).resolves.toEqual({
      behavior: "deny",
      message: "Denied in Pro IDE",
    })
  })

  it("emits only declared provider events into the current generation", async () => {
    const plugin = makePlugin("editor:read")
    plugin.manifest.ide!.providers![0] = {
      id: "virtual",
      kind: "text-document-content",
      handler: "provideText",
      metadata: { scheme: "virtual" },
    }
    let trusted = true
    let authorized = true
    const runtime = new ManagedIdeBrokerRuntime(
      dependencies(plugin, {
        isWorkspaceTrusted: async () => trusted,
        authorize: async () => authorized,
      })
    )
    await runtime.dispatch(await request(plugin, 9))
    const notify = jest.spyOn(codeServerClient, "notifyBroker").mockResolvedValue()

    await runtime.emitProviderEvent({
      root: ROOT,
      pluginId: "acme.tools",
      providerId: "cognia.acme.tools.virtual",
      event: "change",
      payload: { uri: "acme:/document" },
    })
    expect(notify).toHaveBeenCalledWith(ROOT, 9, {
      pluginId: "acme.tools",
      providerId: "cognia.acme.tools.virtual",
      event: "change",
      payload: { uri: "acme:/document" },
    })
    await expect(
      runtime.emitProviderEvent({
        root: ROOT,
        pluginId: "acme.tools",
        providerId: "cognia.acme.tools.virtual",
        event: "execute",
      })
    ).rejects.toThrow("IDE_PROVIDER_EVENT_UNSUPPORTED")

    trusted = false
    await expect(
      runtime.emitProviderEvent({
        root: ROOT,
        pluginId: "acme.tools",
        providerId: "cognia.acme.tools.virtual",
        event: "change",
      })
    ).rejects.toThrow("IDE_WORKSPACE_UNTRUSTED")
    trusted = true

    plugin.status = "disabled"
    await expect(
      runtime.emitProviderEvent({
        root: ROOT,
        pluginId: "acme.tools",
        providerId: "cognia.acme.tools.virtual",
        event: "change",
      })
    ).rejects.toThrow("IDE_PLUGIN_NOT_ACTIVE")
    plugin.status = "enabled"

    await expect(
      runtime.emitProviderEvent({
        root: ROOT,
        pluginId: "acme.tools",
        providerId: "cognia.acme.tools.missing",
        event: "change",
      })
    ).rejects.toThrow("IDE_PROVIDER_NOT_DECLARED")

    authorized = false
    await expect(
      runtime.emitProviderEvent({
        root: ROOT,
        pluginId: "acme.tools",
        providerId: "cognia.acme.tools.virtual",
        event: "change",
      })
    ).rejects.toThrow("IDE_PERMISSION_DENIED")
  })

  it("starts and revalidates declared protocol sessions with a scoped capability ticket", async () => {
    const plugin = makePlugin("editor:read")
    plugin.manifest.permissions = ["editor:read", "process:spawn"]
    plugin.manifest.ide!.executables = [
      {
        id: "server",
        source: {
          kind: "plugin-resource",
          path: "bin/server",
          sha256: `sha256:${"a".repeat(64)}`,
        },
      },
    ]
    plugin.manifest.ide!.protocols = {
      lsp: [{ id: "language", executable: "server", transport: "stdio" }],
    }
    const protocolStart = jest.fn(async () => ({ sessionId: "lsp-session" }))
    const protocolRequest: jest.MockedFunction<ManagedIdeBrokerDependencies["protocolRequest"]> =
      jest.fn(async (_input) => ({ contents: "hover" }))
    const protocolCancel = jest.fn(async () => true)
    const authorize = jest.fn(async () => true)
    const requirePermission = jest.fn()
    const validatePaths = jest.fn(async (_root: string, paths: string[]) => paths)
    const runtime = new ManagedIdeBrokerRuntime(
      dependencies(plugin, {
        protocolStart,
        protocolRequest,
        protocolCancel,
        authorize,
        requirePermission,
        validatePaths,
      })
    )
    const manifest = normalizeIdeManifest(plugin.manifest.id, plugin.manifest).manifest
    const common = {
      invocationId: "protocol-1",
      pluginId: plugin.manifest.id,
      pluginVersion: plugin.manifest.version,
      manifestHash: await hashIdeManifest(manifest),
      catalogHash: IDE_CAPABILITY_CATALOG.catalogHash,
      hostId: "local",
      workspaceRoot: ROOT,
      workspaceTrusted: true,
      family: "lsp",
      protocolId: "cognia.acme.tools.language",
    }
    const started = (await runtime.dispatch({
      root: ROOT,
      generation: 3,
      id: "start",
      method: "cognia/protocol/start",
      params: common,
    })) as { capabilityTicket: string }
    expect(started.capabilityTicket).toEqual(expect.any(String))
    expect(authorize).toHaveBeenCalledWith(
      "acme.tools",
      "process:spawn",
      "Managed IDE lsp protocol start"
    )
    await expect(
      runtime.dispatch({
        root: ROOT,
        generation: 3,
        id: "request",
        method: "cognia/protocol/request",
        params: {
          ...common,
          capabilityTicket: started.capabilityTicket,
          method: "textDocument/hover",
          payload: { textDocument: { uri: "file:///work/project/main.ts" } },
        },
      })
    ).resolves.toEqual({ contents: "hover" })
    expect(protocolStart).toHaveBeenCalledWith(
      expect.objectContaining({
        family: "lsp",
        server: expect.objectContaining({ id: "cognia.acme.tools.language" }),
      })
    )
    expect(protocolRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: "textDocument/hover" })
    )
    expect(validatePaths).toHaveBeenCalledWith(ROOT, [`${ROOT}/main.ts`])
    expect(requirePermission).toHaveBeenCalledTimes(2)

    let resolvePending!: (value: unknown) => void
    protocolRequest.mockImplementationOnce(
      () => new Promise((resolve) => (resolvePending = resolve))
    )
    const pending = runtime.dispatch({
      root: ROOT,
      generation: 3,
      id: "request-2",
      method: "cognia/protocol/request",
      params: {
        ...common,
        invocationId: "protocol-2",
        capabilityTicket: started.capabilityTicket,
        method: "textDocument/hover",
        payload: {},
      },
    })
    for (let index = 0; index < 20 && protocolRequest.mock.calls.length < 2; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(protocolRequest).toHaveBeenCalledTimes(2)
    expect(
      runtime.cancel({
        root: ROOT,
        generation: 3,
        method: "cognia/protocol/cancel",
        params: {
          invocationId: "protocol-2",
          pluginId: plugin.manifest.id,
          protocolId: "cognia.acme.tools.language",
        },
      })
    ).toBe(true)
    expect(protocolCancel).toHaveBeenCalledWith(
      expect.objectContaining({ invocationId: "protocol-2" })
    )
    resolvePending(null)
    await expect(pending).rejects.toThrow("IDE_PROTOCOL_CANCELLED")
  })

  it("fails and cancels pending protocol requests when the broker disconnects", async () => {
    const plugin = makeProtocolPlugin()
    const protocolRequest = jest.fn(() => new Promise<unknown>(() => undefined))
    const protocolCancel = jest.fn(async () => true)
    const runtime = new ManagedIdeBrokerRuntime(
      dependencies(plugin, { protocolRequest, protocolCancel })
    )
    const { common, capabilityTicket } = await startProtocol(runtime, plugin, 11)
    const pending = runtime.dispatch({
      root: ROOT,
      generation: 11,
      id: "request",
      method: "cognia/protocol/request",
      params: {
        ...common,
        invocationId: "protocol-disconnect",
        capabilityTicket,
        method: "textDocument/hover",
        payload: {},
      },
    })
    while (protocolRequest.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    runtime.disconnect(ROOT)

    await expect(pending).rejects.toThrow("IDE_BROKER_DISCONNECTED")
    expect(protocolCancel).toHaveBeenCalledWith({
      root: ROOT,
      generation: 11,
      pluginId: "acme.tools",
      protocolId: "cognia.acme.tools.language",
      consumerId: undefined,
      invocationId: "protocol-disconnect",
    })
  })

  it("synchronizes protocol documents, stops sessions, and revokes their tickets", async () => {
    const plugin = makeProtocolPlugin()
    const protocolDocument = jest.fn(async () => undefined)
    const protocolStop = jest.fn(async () => undefined)
    const validatePaths = jest.fn(async (_root: string, paths: string[]) => paths)
    const runtime = new ManagedIdeBrokerRuntime(
      dependencies(plugin, { protocolDocument, protocolStop, validatePaths })
    )
    const { common, capabilityTicket } = await startProtocol(runtime, plugin, 21)
    const documentRequest: CodeServerBrokerRequest = {
      root: ROOT,
      generation: 21,
      id: "document",
      method: "cognia/protocol/document",
      params: {
        ...common,
        invocationId: "document-1",
        capabilityTicket,
        document: {
          operation: "open",
          uri: "file:///work/project/main.ts",
          languageId: "typescript",
          text: "export {}",
        },
      },
    }

    await expect(runtime.dispatch(documentRequest)).resolves.toBeNull()
    expect(validatePaths).toHaveBeenCalledWith(ROOT, [`${ROOT}/main.ts`])
    expect(protocolDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "open",
        uri: "file:///work/project/main.ts",
        text: "export {}",
      })
    )
    await expect(
      runtime.dispatch({
        root: ROOT,
        generation: 21,
        id: "stop",
        method: "cognia/protocol/stop",
        params: { ...common, capabilityTicket },
      })
    ).resolves.toBeNull()
    expect(protocolStop).toHaveBeenCalledWith({
      root: ROOT,
      generation: 21,
      pluginId: "acme.tools",
      protocolId: "cognia.acme.tools.language",
      consumerId: undefined,
    })
    await expect(runtime.dispatch(documentRequest)).rejects.toThrow("IDE_CAPABILITY_TICKET_INVALID")
  })

  it("rejects forged protocol scopes, undeclared servers, permissions, and confirmations", async () => {
    const plugin = makeProtocolPlugin()
    const common = await protocolCommon(plugin)
    const cases: Array<{
      mutate: (params: Record<string, unknown>) => void
      error: string
    }> = [
      {
        mutate: (params) => {
          params.workspaceRoot = "/work/other"
        },
        error: "IDE_WORKSPACE_SCOPE_MISMATCH",
      },
      {
        mutate: (params) => {
          params.hostId = "remote"
        },
        error: "IDE_HOST_SCOPE_MISMATCH",
      },
      {
        mutate: (params) => {
          params.pluginVersion = "2.0.0"
        },
        error: "IDE_PLUGIN_VERSION_MISMATCH",
      },
      {
        mutate: (params) => {
          params.catalogHash = "sha256:forged"
        },
        error: "IDE_CATALOG_MISMATCH",
      },
      {
        mutate: (params) => {
          params.manifestHash = "sha256:forged"
        },
        error: "IDE_MANIFEST_HASH_MISMATCH",
      },
      {
        mutate: (params) => {
          params.protocolId = "cognia.acme.tools.missing"
        },
        error: "IDE_PROTOCOL_NOT_DECLARED",
      },
    ]
    for (const [index, testCase] of cases.entries()) {
      const params = { ...common, invocationId: `forged-protocol-${index}` }
      testCase.mutate(params)
      await expect(
        new ManagedIdeBrokerRuntime(dependencies(plugin)).dispatch({
          root: ROOT,
          generation: 1,
          id: `forged-${index}`,
          method: "cognia/protocol/start",
          params,
        })
      ).rejects.toThrow(testCase.error)
    }

    await expect(
      new ManagedIdeBrokerRuntime(
        dependencies(plugin, { isWorkspaceTrusted: async () => false })
      ).dispatch({
        root: ROOT,
        generation: 1,
        id: "untrusted",
        method: "cognia/protocol/start",
        params: common,
      })
    ).rejects.toThrow("IDE_WORKSPACE_UNTRUSTED")

    const disabled = makeProtocolPlugin()
    disabled.status = "disabled"
    await expect(
      new ManagedIdeBrokerRuntime(dependencies(disabled)).dispatch({
        root: ROOT,
        generation: 1,
        id: "disabled",
        method: "cognia/protocol/start",
        params: await protocolCommon(disabled),
      })
    ).rejects.toThrow("IDE_PLUGIN_NOT_ACTIVE")

    const undeclaredPermission = makeProtocolPlugin()
    undeclaredPermission.manifest.permissions = ["editor:read"]
    await expect(
      new ManagedIdeBrokerRuntime(dependencies(undeclaredPermission)).dispatch({
        root: ROOT,
        generation: 1,
        id: "missing-permission",
        method: "cognia/protocol/start",
        params: await protocolCommon(undeclaredPermission),
      })
    ).rejects.toThrow("IDE_PERMISSION_NOT_DECLARED")

    await expect(
      new ManagedIdeBrokerRuntime(dependencies(plugin, { authorize: async () => false })).dispatch({
        root: ROOT,
        generation: 1,
        id: "denied",
        method: "cognia/protocol/start",
        params: common,
      })
    ).rejects.toThrow("IDE_CONTEXTUAL_CONFIRMATION_DENIED")
  })

  it("validates protocol methods, documents, tickets, and protocol families", async () => {
    const plugin = makeProtocolPlugin()
    let now = 1_000
    const runtime = new ManagedIdeBrokerRuntime(dependencies(plugin, { now: () => now }))
    const { common, capabilityTicket } = await startProtocol(runtime, plugin, 51)

    await expect(
      runtime.dispatch({
        root: ROOT,
        generation: 51,
        id: "missing-method",
        method: "cognia/protocol/request",
        params: { ...common, capabilityTicket },
      })
    ).rejects.toThrow("IDE_PROTOCOL_METHOD_REQUIRED")
    await expect(
      runtime.dispatch({
        root: ROOT,
        generation: 51,
        id: "missing-document",
        method: "cognia/protocol/document",
        params: { ...common, capabilityTicket },
      })
    ).rejects.toThrow("IDE_PROTOCOL_DOCUMENT_REQUIRED")
    await expect(
      runtime.dispatch({
        root: ROOT,
        generation: 51,
        id: "unknown-protocol-operation",
        method: "cognia/protocol/unknown",
        params: { ...common, capabilityTicket },
      })
    ).rejects.toThrow("IDE_BROKER_METHOD_NOT_FOUND")

    now += 5 * 60_000 + 1
    await expect(
      runtime.dispatch({
        root: ROOT,
        generation: 51,
        id: "expired-ticket",
        method: "cognia/protocol/request",
        params: {
          ...common,
          capabilityTicket,
          method: "textDocument/hover",
        },
      })
    ).rejects.toThrow("IDE_CAPABILITY_TICKET_INVALID")

    const invalidFamily = { ...(await protocolCommon(plugin)), family: "ftp" }
    await expect(
      new ManagedIdeBrokerRuntime(dependencies(plugin)).dispatch({
        root: ROOT,
        generation: 1,
        id: "invalid-family",
        method: "cognia/protocol/start",
        params: invalidFamily,
      })
    ).rejects.toThrow("IDE_PROTOCOL_PARAMS_INVALID")
    const invalidTrust = {
      ...(await protocolCommon(plugin)),
      workspaceTrusted: "yes",
    }
    await expect(
      new ManagedIdeBrokerRuntime(dependencies(plugin)).dispatch({
        root: ROOT,
        generation: 1,
        id: "invalid-trust",
        method: "cognia/protocol/start",
        params: invalidTrust,
      })
    ).rejects.toThrow("IDE_PROTOCOL_PARAMS_INVALID")
  })

  it("rejects malformed provider and protocol calls and opens failing provider circuits", async () => {
    const plugin = makePlugin("editor:read")
    let now = 1_000
    const invoke = jest
      .fn<Promise<unknown>, [string, string, unknown[]]>()
      .mockRejectedValueOnce(new Error("provider failed"))
      .mockRejectedValueOnce(new Error("provider failed"))
      .mockRejectedValueOnce(new Error("provider failed"))
      .mockResolvedValue("recovered")
    const runtime = new ManagedIdeBrokerRuntime(dependencies(plugin, { invoke, now: () => now }))

    await expect(
      runtime.dispatch({
        root: ROOT,
        generation: 1,
        id: "invalid",
        method: "cognia/provider/invoke",
        params: null,
      })
    ).rejects.toThrow("IDE_PROVIDER_PARAMS_INVALID")
    await expect(
      runtime.dispatch({
        root: ROOT,
        generation: 1,
        id: "unknown",
        method: "cognia/unknown",
        params: {},
      })
    ).rejects.toThrow("IDE_BROKER_METHOD_NOT_FOUND")
    await expect(
      runtime.dispatch({
        root: ROOT,
        generation: 1,
        id: "protocol-invalid",
        method: "cognia/protocol/request",
        params: {},
      })
    ).rejects.toThrow("IDE_PROTOCOL_PARAMS_INVALID")

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(
        runtime.dispatch(await request(plugin, 1, `failure-${attempt}`))
      ).rejects.toThrow("provider failed")
    }
    await expect(runtime.dispatch(await request(plugin, 1, "circuit-open"))).rejects.toThrow(
      "IDE_PROVIDER_CIRCUIT_OPEN"
    )
    expect(invoke).toHaveBeenCalledTimes(3)

    now += 30_001
    await expect(runtime.dispatch(await request(plugin, 1, "circuit-recovered"))).resolves.toBe(
      "recovered"
    )
  })

  it("rejects malformed provider identities, host paths, handles, and agent prompts", async () => {
    const plugin = makePlugin("editor:read")
    const runtime = new ManagedIdeBrokerRuntime(dependencies(plugin))

    const missingPlugin = await request(plugin, 1, "missing-plugin")
    ;(missingPlugin.params as { pluginId: string }).pluginId = ""
    await expect(runtime.dispatch(missingPlugin)).rejects.toThrow("IDE_PROVIDER_PARAMS_INVALID")

    const invalidTrust = await request(plugin, 1, "invalid-trust")
    ;(invalidTrust.params as { workspaceTrusted: unknown }).workspaceTrusted = "yes"
    await expect(runtime.dispatch(invalidTrust)).rejects.toThrow("IDE_PROVIDER_PARAMS_INVALID")

    const invalidArguments = await request(plugin, 1, "invalid-arguments")
    ;(invalidArguments.params as { arguments: unknown }).arguments = {}
    await expect(runtime.dispatch(invalidArguments)).rejects.toThrow("IDE_PROVIDER_PARAMS_INVALID")

    for (const [invocationId, args, error] of [
      ["remote-uri", [{ uri: "file://remote/work/project/main.ts" }], "IDE_FILE_URI_INVALID"],
      ["relative-path", [{ path: "relative/main.ts" }], "IDE_HOST_PATH_NOT_ABSOLUTE"],
      [
        "relative-uri-object",
        [{ scheme: "file", path: "relative/main.ts" }],
        "IDE_HOST_PATH_NOT_ABSOLUTE",
      ],
      ["invalid-handle", [{ $type: "ContentHandle", id: "" }], "IDE_CONTENT_HANDLE_INVALID"],
    ] as const) {
      const invalid = await request(plugin, 1, invocationId)
      ;(invalid.params as { arguments: unknown[] }).arguments = [...args]
      await expect(runtime.dispatch(invalid)).rejects.toThrow(error)
    }

    const cyclicValue: Record<string, unknown> = {}
    cyclicValue.self = cyclicValue
    const cyclic = await request(plugin, 1, "cyclic")
    ;(cyclic.params as { arguments: unknown[] }).arguments = [cyclicValue]
    await expect(runtime.dispatch(cyclic)).rejects.toThrow("IDE_PROVIDER_VALUE_CYCLIC")

    for (const [field, value] of [
      ["providerKind", "definition"],
      ["handler", "forgedHandler"],
      ["permission", "editor:write"],
    ] as const) {
      const forged = await request(plugin, 1, `forged-${field}`)
      ;(forged.params as Record<string, unknown>)[field] = value
      await expect(runtime.dispatch(forged)).rejects.toThrow("IDE_PROVIDER_NOT_DECLARED")
    }

    const agent = makeAgentPlugin()
    const invalidPrompt = await request(agent, 1, "invalid-agent-prompt")
    ;(invalidPrompt.params as { arguments: unknown[] }).arguments = [{}]
    await expect(
      new ManagedIdeBrokerRuntime(dependencies(agent)).dispatch(invalidPrompt)
    ).rejects.toThrow("IDE_AGENT_PROMPT_INVALID")
  })

  it("enforces declared and contextual provider permissions on every invocation", async () => {
    const readPlugin = makePlugin("editor:read")
    await expect(
      new ManagedIdeBrokerRuntime(
        dependencies(readPlugin, { authorize: async () => false })
      ).dispatch(await request(readPlugin))
    ).rejects.toThrow("IDE_PERMISSION_DENIED")

    const writePlugin = makeAgentPlugin()
    const writeRequest = await request(writePlugin)
    ;(writeRequest.params as { arguments: unknown[] }).arguments = [{ prompt: "inspect" }]
    await expect(
      new ManagedIdeBrokerRuntime(
        dependencies(writePlugin, { authorize: async () => false })
      ).dispatch(writeRequest)
    ).rejects.toThrow("IDE_CONTEXTUAL_CONFIRMATION_DENIED")

    const undeclared = makeAgentPlugin()
    undeclared.manifest.permissions = ["editor:read"]
    const undeclaredRequest = await request(undeclared)
    ;(undeclaredRequest.params as { arguments: unknown[] }).arguments = [{ prompt: "inspect" }]
    await expect(
      new ManagedIdeBrokerRuntime(dependencies(undeclared)).dispatch(undeclaredRequest)
    ).rejects.toThrow("IDE_PERMISSION_NOT_DECLARED")

    const invalidTicket = await request(writePlugin, 1, "invalid-capability-ticket")
    ;(invalidTicket.params as { arguments: unknown[] }).arguments = [{ prompt: "inspect" }]
    ;(invalidTicket.params as { capabilityTicket: string }).capabilityTicket = "forged"
    const authorize = jest.fn(async () => true)
    await expect(
      new ManagedIdeBrokerRuntime(dependencies(writePlugin, { authorize })).dispatch(invalidTicket)
    ).resolves.toBe("ok")
    expect(authorize).toHaveBeenCalled()
  })

  it("validates cancellation and approval notifications before looking up invocations", async () => {
    const plugin = makePlugin("editor:read")
    const runtime = new ManagedIdeBrokerRuntime(dependencies(plugin))
    await runtime.dispatch(await request(plugin, 41, "establish-generation"))

    expect(() =>
      runtime.cancel({
        root: ROOT,
        generation: 41,
        method: "cognia/provider/cancel",
        params: null,
      })
    ).toThrow("IDE_PROVIDER_CANCEL_PARAMS_INVALID")
    expect(() =>
      runtime.cancel({
        root: ROOT,
        generation: 41,
        method: "cognia/provider/cancel",
        params: {
          invocationId: "",
          pluginId: "acme.tools",
          providerId: "cognia.acme.tools.hover",
          operation: "provide",
        },
      })
    ).toThrow("IDE_PROVIDER_CANCEL_PARAMS_INVALID")
    expect(
      runtime.cancel({
        root: ROOT,
        generation: 41,
        method: "cognia/unknown",
        params: {},
      })
    ).toBe(false)

    expect(() =>
      runtime.cancel({
        root: ROOT,
        generation: 41,
        method: "cognia/provider/approvalResponse",
        params: null,
      })
    ).toThrow("IDE_AGENT_APPROVAL_PARAMS_INVALID")
    for (const params of [
      {
        invocationId: "",
        requestId: "request",
        pluginId: "acme.tools",
        providerId: "cognia.acme.tools.hover",
        decision: "allow",
      },
      {
        invocationId: "invoke",
        requestId: "request",
        pluginId: "acme.tools",
        providerId: "cognia.acme.tools.hover",
        decision: "later",
      },
      {
        invocationId: "invoke",
        requestId: "request",
        pluginId: "acme.tools",
        providerId: "cognia.acme.tools.hover",
        decision: "allow",
        updatedInput: [],
      },
      {
        invocationId: "invoke",
        requestId: "request",
        pluginId: "acme.tools",
        providerId: "cognia.acme.tools.hover",
        decision: "deny",
        message: 7,
      },
    ]) {
      expect(() =>
        runtime.cancel({
          root: ROOT,
          generation: 41,
          method: "cognia/provider/approvalResponse",
          params,
        })
      ).toThrow("IDE_AGENT_APPROVAL_PARAMS_INVALID")
    }

    expect(() =>
      runtime.cancel({
        root: ROOT,
        generation: 41,
        method: "cognia/protocol/cancel",
        params: null,
      })
    ).toThrow("IDE_PROTOCOL_CANCEL_PARAMS_INVALID")
    expect(() =>
      runtime.cancel({
        root: ROOT,
        generation: 41,
        method: "cognia/protocol/cancel",
        params: {
          invocationId: "",
          pluginId: "acme.tools",
          protocolId: "cognia.acme.tools.language",
        },
      })
    ).toThrow("IDE_PROTOCOL_CANCEL_PARAMS_INVALID")
    expect(() =>
      runtime.cancel({
        root: ROOT,
        generation: 41,
        method: "cognia/protocol/cancel",
        params: {
          invocationId: "invoke",
          pluginId: "acme.tools",
          protocolId: "cognia.acme.tools.language",
          consumerId: 7,
        },
      })
    ).toThrow("IDE_PROTOCOL_CANCEL_PARAMS_INVALID")
  })

  it("adapts headless broker events and disposes every subscription", async () => {
    const handlers = new Map<string, (payload: unknown) => void>()
    const unsubscribers = [jest.fn(), jest.fn(), jest.fn()]
    let subscription = 0
    const transport = {
      subscribe: jest.fn((event: string, handler: (payload: unknown) => void) => {
        handlers.set(event, handler)
        return unsubscribers[subscription++]
      }),
    }
    const dispatch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("provider unavailable"))
    const cancel = jest.fn()
    const disconnect = jest.fn()
    const runtime = { dispatch, cancel, disconnect } as unknown as ManagedIdeBrokerRuntime
    const respond = jest.spyOn(codeServerClient, "respondToBroker").mockResolvedValue()
    const dispose = attachManagedIdeBrokerTransport(transport, runtime)
    const successful = await request(makePlugin("editor:read"), 31, "transport-success")
    const failed = await request(makePlugin("editor:read"), 31, "transport-failure")
    const notification: CodeServerBrokerNotification = {
      root: ROOT,
      generation: 31,
      method: "cognia/provider/cancel",
      params: {},
    }

    handlers.get(CODESERVER_EVENTS.brokerRequest)?.(successful)
    handlers.get(CODESERVER_EVENTS.brokerRequest)?.(failed)
    handlers.get(CODESERVER_EVENTS.brokerNotification)?.(notification)
    handlers.get(CODESERVER_EVENTS.instanceExited)?.({ root: ROOT })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(respond).toHaveBeenNthCalledWith(1, successful, { result: { ok: true } })
    expect(respond).toHaveBeenNthCalledWith(2, failed, {
      error: expect.objectContaining({
        code: -32603,
        message: "provider unavailable",
      }),
    })
    expect(cancel).toHaveBeenCalledWith(notification)
    expect(disconnect).toHaveBeenCalledWith(ROOT)

    dispose()
    for (const unsubscribe of unsubscribers) expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})

function makeProtocolPlugin(): Plugin {
  const plugin = makePlugin("editor:read")
  plugin.manifest.permissions = ["editor:read", "process:spawn"]
  plugin.manifest.ide!.executables = [
    {
      id: "server",
      source: {
        kind: "plugin-resource",
        path: "bin/server",
        sha256: `sha256:${"a".repeat(64)}`,
      },
    },
  ]
  plugin.manifest.ide!.protocols = {
    lsp: [{ id: "language", executable: "server", transport: "stdio" }],
  }
  return plugin
}

function makeAgentPlugin(): Plugin {
  const plugin = makePlugin("editor:read")
  plugin.manifest.permissions = ["editor:read", "agent:control"]
  plugin.manifest.ide!.providers = []
  plugin.manifest.ide!.agents = [
    {
      id: "assistant",
      agentId: "researcher",
      name: "Researcher",
    },
  ]
  return plugin
}

function makeCommandPlugin(): Plugin {
  const plugin = makePlugin("editor:read")
  plugin.manifest.permissions = []
  plugin.manifest.ide!.providers = [
    {
      id: "command",
      kind: "command",
      handler: "executeCommand",
    },
  ]
  return plugin
}

async function startProtocol(
  runtime: ManagedIdeBrokerRuntime,
  plugin: Plugin,
  generation: number
): Promise<{ common: Record<string, unknown>; capabilityTicket: string }> {
  const common = await protocolCommon(plugin)
  const started = (await runtime.dispatch({
    root: ROOT,
    generation,
    id: "start",
    method: "cognia/protocol/start",
    params: common,
  })) as { capabilityTicket: string }
  return { common, capabilityTicket: started.capabilityTicket }
}

async function protocolCommon(plugin: Plugin): Promise<Record<string, unknown>> {
  const manifest = normalizeIdeManifest(plugin.manifest.id, plugin.manifest).manifest
  return {
    invocationId: "protocol-start",
    pluginId: plugin.manifest.id,
    pluginVersion: plugin.manifest.version,
    manifestHash: await hashIdeManifest(manifest),
    catalogHash: IDE_CAPABILITY_CATALOG.catalogHash,
    hostId: "local",
    workspaceRoot: ROOT,
    workspaceTrusted: true,
    family: "lsp",
    protocolId: "cognia.acme.tools.language",
  }
}

function makePlugin(permission: PluginPermission): Plugin {
  return {
    manifest: {
      id: "acme.tools",
      name: "Acme Tools",
      version: "1.0.0",
      type: "frontend",
      description: "test",
      author: "Acme",
      capabilities: [],
      permissions: [permission],
      ide: {
        schemaVersion: 1,
        targets: ["pro-ide"],
        providers: [
          {
            id: "hover",
            kind: permission === "editor:write" ? "code-action" : "hover",
            handler: "provideHover",
          },
        ],
      },
    },
    status: "enabled",
    source: "local",
    path: ROOT,
    config: {},
  } as unknown as Plugin
}

function dependencies(
  plugin: Plugin,
  overrides: Partial<ManagedIdeBrokerDependencies> = {}
): ManagedIdeBrokerDependencies {
  return {
    getPlugin: () => plugin,
    isWorkspaceTrusted: async () => true,
    validatePaths: async (_root, paths) => paths,
    createContent: async () => ({ $type: "ContentHandle", id: "created" }),
    redeemContent: async () => new Uint8Array(),
    authorize: async () => true,
    requirePermission: () => undefined,
    invoke: async () => "ok",
    invokeAgent: async () => "ok",
    protocolStart: async () => ({ sessionId: "session" }),
    protocolRequest: async () => null,
    protocolCancel: async () => false,
    protocolDocument: async () => undefined,
    protocolStop: async () => undefined,
    getUserId: () => "acct_test",
    stateGet: async () => undefined,
    stateSet: async () => undefined,
    stateDelete: async () => undefined,
    stateKeys: async () => [],
    secretGet: async () => null,
    secretSet: async () => undefined,
    secretDelete: async () => undefined,
    secretKeys: async () => [],
    expectedHostId: "local",
    now: () => 1_000,
    ...overrides,
  }
}

async function request(
  plugin: Plugin,
  generation = 1,
  invocationId = "invoke-1"
): Promise<CodeServerBrokerRequest> {
  const manifest = normalizeIdeManifest(plugin.manifest.id, plugin.manifest).manifest
  const provider = manifest.providers[0]
  return {
    root: ROOT,
    generation,
    id: "proxy:1",
    method: "cognia/provider/invoke",
    params: {
      invocationId,
      pluginId: plugin.manifest.id,
      pluginVersion: plugin.manifest.version,
      manifestHash: await hashIdeManifest(manifest),
      catalogHash: IDE_CAPABILITY_CATALOG.catalogHash,
      hostId: "local",
      workspaceRoot: ROOT,
      workspaceTrusted: true,
      providerId: provider.id,
      providerKind: provider.kind,
      handler: provider.handler,
      permission: provider.permission ?? null,
      operation: "provide",
      arguments: [{ uri: `file://${ROOT}/main.ts` }],
    },
  }
}

async function storageRequest(
  plugin: Plugin,
  method:
    | "cognia/state/get"
    | "cognia/state/set"
    | "cognia/state/delete"
    | "cognia/state/keys"
    | "cognia/secrets/get"
    | "cognia/secrets/set"
    | "cognia/secrets/delete"
    | "cognia/secrets/keys",
  params: {
    area: "global" | "workspace"
    key?: string
    value?: unknown
  }
): Promise<CodeServerBrokerRequest> {
  const manifest = normalizeIdeManifest(plugin.manifest.id, plugin.manifest).manifest
  return {
    root: ROOT,
    generation: 1,
    id: `storage:${method}`,
    method,
    params: {
      pluginId: plugin.manifest.id,
      pluginVersion: plugin.manifest.version,
      manifestHash: await hashIdeManifest(manifest),
      catalogHash: IDE_CAPABILITY_CATALOG.catalogHash,
      hostId: "local",
      workspaceRoot: ROOT,
      workspaceTrusted: true,
      ...params,
    },
  }
}
