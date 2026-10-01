jest.mock("@/stores/remote-host/remote-host-store", () => ({
  activeHostFeatureManifest: jest.fn(() => ({
    schemaVersion: 1,
    features: {
      "external-agent.process-plane": { version: 1, operations: ["agent_tool_host_control"] },
    },
  })),
}))
jest.mock("@/lib/claude/feature-call", () => ({
  ...jest.requireActual("@/lib/claude/feature-call"),
  callSidecarToolHost: jest.fn(),
}))
jest.mock("@/lib/claude/plugin-tool-ipc", () => ({ handlePluginToolExec: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ transport: { subscribe: jest.fn() } }))
jest.mock("@/lib/claude/adapter-hooks", () => ({
  dispatchPostToolUse: jest.fn(),
  dispatchPreToolUse: jest.fn(async () => ({ action: "allow" })),
}))

import type { ToolHostEvent, SendOptions } from "@cognia/agent-config-types"
import { createRendererToolHost, RENDERER_TOOL_HOST_APPROVAL_PREFIX } from "./renderer-tool-host"
import { callSidecarToolHost } from "@/lib/claude/feature-call"
import { handlePluginToolExec } from "@/lib/claude/plugin-tool-ipc"
import { transport } from "@/lib/tauri"
import {
  setActiveRemoteTransport,
  setActiveRemoteEndpoint,
  __resetRoutingForTests,
} from "@/lib/tauri/transport-routing"
import {
  registerSpawnPlacement,
  __resetSpawnPlacementsForTests,
} from "@/lib/sandbox/spawn-placement-registry"
import { activeHostFeatureManifest } from "@/stores/remote-host/remote-host-store"
import type { Transport } from "@/lib/tauri/transport-types"

const leaseId = "renderer-tool-host-test-lease"
const sendOptions = { cwd: "/workspace" } as SendOptions
const descriptor = {
  leaseId,
  generation: 1,
  catalogFingerprint: "catalog-fixture",
  mcpServers: [
    {
      name: "cognia-tools",
      transport: "http",
      url: "http://127.0.0.1:8765/cognia-tools",
      headers: { Authorization: "Bearer fixture" },
    },
  ],
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

function setup() {
  let handler: (event: ToolHostEvent) => void = () => undefined
  const unsubscribe = jest.fn()
  const call = jest.fn(async (operation: string, _input: unknown): Promise<unknown> =>
    operation === "tool-host-start" ? descriptor : {}
  )
  const execute = jest.fn(async (request) => ({
    type: "plugin_tool_response" as const,
    sessionId: request.sessionId,
    toolUseId: request.toolUseId,
    result: "done",
  }))
  const review = jest.fn(async () => ({ modifiedResult: "reviewed output" }))
  const before = jest.fn<
    ReturnType<typeof import("@/lib/claude/adapter-hooks").dispatchPreToolUse>,
    Parameters<typeof import("@/lib/claude/adapter-hooks").dispatchPreToolUse>
  >(async () => ({ action: "allow" }))
  const host = createRendererToolHost("chat-1", {
    call,
    execute,
    review,
    before,
    randomUUID: () => leaseId,
    subscribe: (listener) => {
      handler = listener
      return unsubscribe
    },
  })
  const emit = (event: ToolHostEvent["event"], envelope: Partial<ToolHostEvent> = {}) =>
    handler({
      type: "tool_host_event",
      leaseId,
      sessionId: "chat-1",
      generation: 1,
      event,
      ...envelope,
    })
  return { host, call, execute, review, before, emit, unsubscribe }
}
const permission = {
  type: "permission_request" as const,
  sessionId: "chat-1",
  requestId: "ask-1",
  toolUseID: "tool-1",
  toolName: "write",
  input: { path: "note.txt" },
}
const plugin = {
  type: "plugin_tool_exec" as const,
  sessionId: "chat-1",
  toolUseId: "tool-2",
  name: "ask_user",
  args: { question: "Which file?" },
}

describe("renderer Cognia tool host", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it("wires production subscriptions and shared execution without dependency overrides", async () => {
    const uuid = jest
      .spyOn(crypto, "randomUUID")
      .mockReturnValue("00000000-0000-4000-8000-000000000001")
    jest
      .mocked(callSidecarToolHost)
      .mockResolvedValue({ ...descriptor, leaseId: crypto.randomUUID() })
    let handler!: (event: ToolHostEvent) => void
    jest.mocked(transport.subscribe).mockImplementation((_channel, listener) => {
      handler = listener as typeof handler
      return jest.fn()
    })
    jest.mocked(handlePluginToolExec).mockResolvedValue({
      type: "plugin_tool_response",
      sessionId: "chat-1",
      toolUseId: plugin.toolUseId,
      result: { ok: true },
    })
    const host = createRendererToolHost("chat-1")
    await host.start({ sendOptions })
    handler({
      type: "tool_host_event",
      sessionId: "chat-1",
      leaseId: crypto.randomUUID(),
      generation: 1,
      event: plugin,
    })
    await flush()
    expect(handlePluginToolExec).toHaveBeenCalled()
    await host.close()
    uuid.mockRestore()
  })

  it("ignores a delayed cancellation from an older turn", async () => {
    const { host, call, emit, execute } = setup()
    await host.start({ sendOptions })
    await host.pause()
    call.mockResolvedValueOnce({ ...descriptor, generation: 2 })
    await host.start({ sendOptions })
    emit({ type: "tool_host_cancel", sessionId: "chat-1" }, { generation: 1 })
    emit(plugin, { generation: 2 })
    await flush()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenLastCalledWith(
      "tool-host-reply",
      expect.objectContaining({ generation: 2 })
    )
    await host.close()
  })

  it("reviews model-visible tool outputs through the shared PostToolUse hook", async () => {
    const { host, emit, call, review } = setup()
    await host.start({ sendOptions })
    emit({
      type: "tool_result_review",
      sessionId: "chat-1",
      reviewId: "review-1",
      toolUseId: "tool-1",
      toolName: "read",
      input: { path: "note.txt" },
      result: "original",
      isError: false,
    })
    await flush()
    expect(review).toHaveBeenCalledWith("read", { path: "note.txt" }, "original", "chat-1")
    expect(call).toHaveBeenLastCalledWith(
      "tool-host-reply",
      expect.objectContaining({
        kind: "review",
        id: "review-1",
        result: { updatedResult: "reviewed output" },
      })
    )
    review.mockRejectedValueOnce(new Error("hook unavailable"))
    emit({
      type: "tool_result_review",
      sessionId: "chat-1",
      reviewId: "review-2",
      toolUseId: "tool-1",
      toolName: "read",
      result: "original",
      isError: false,
    })
    await flush()
    expect(call).toHaveBeenLastCalledWith(
      "tool-host-reply",
      expect.objectContaining({ kind: "review", id: "review-2", result: {} })
    )
    await host.close()
  })

  it("honors the existing plugin pre-tool firewall before showing approval UI", async () => {
    const { host, emit, call, before } = setup()
    const onPermissionRequest = jest.fn()
    await host.start({ sendOptions, onPermissionRequest })
    before.mockResolvedValueOnce({ action: "deny", reason: "plugin policy" })
    const preflight = {
      type: "tool_host_pre_tool" as const,
      sessionId: "chat-1",
      requestId: "preflight-1",
      toolName: "read",
      input: { path: "file.txt" },
    }
    emit(preflight)
    await flush()
    expect(onPermissionRequest).not.toHaveBeenCalled()
    expect(call).toHaveBeenLastCalledWith(
      "tool-host-reply",
      expect.objectContaining({
        kind: "preflight",
        result: { action: "deny", reason: "plugin policy" },
      })
    )
    before.mockResolvedValueOnce({ action: "modify", modifiedArgs: { path: "safe.txt" } })
    emit({ ...preflight, requestId: "rewrite" })
    await flush()
    expect(onPermissionRequest).not.toHaveBeenCalled()
    expect(call).toHaveBeenLastCalledWith(
      "tool-host-reply",
      expect.objectContaining({ result: { action: "modify", modifiedArgs: { path: "safe.txt" } } })
    )
    before.mockRejectedValueOnce(new Error("hook unavailable"))
    emit({ ...preflight, requestId: "broken" })
    await flush()
    expect(call).toHaveBeenLastCalledWith(
      "tool-host-reply",
      expect.objectContaining({
        result: { action: "deny", reason: "Cognia tool preflight failed" },
      })
    )
    await host.close()
  })

  it("cancels one MCP permission callback without aborting its sibling request", async () => {
    const { host, emit, call } = setup()
    const requests = new Map<
      string,
      { signal: AbortSignal; finish: (value: { decision: "allow" }) => void }
    >()
    await host.start({
      sendOptions,
      onPermissionRequest: (request, signal) =>
        new Promise((finish) => {
          requests.set(request.toolUseID, { signal, finish })
        }),
    })
    emit(permission)
    emit({ ...permission, requestId: "ask-2", toolUseID: "tool-3" })
    await flush()
    emit({ type: "tool_host_call_cancel", sessionId: "chat-1", kind: "permission", id: "ask-1" })
    expect(requests.get("tool-1")!.signal.aborted).toBe(true)
    expect(requests.get("tool-3")!.signal.aborted).toBe(false)
    for (const request of requests.values()) request.finish({ decision: "allow" })
    await flush()
    expect(call.mock.calls.filter(([operation]) => operation === "tool-host-reply")).toEqual([
      ["tool-host-reply", expect.objectContaining({ id: "ask-2" })],
    ])
    await host.close()
  })

  it("keeps one endpoint and lease while renewing and updating each paused turn", async () => {
    const { host, call, unsubscribe } = setup()
    const first = await host.start({ sendOptions })
    expect(first.mcpServers).toEqual([
      {
        type: "http",
        name: "cognia-tools",
        url: descriptor.mcpServers[0].url,
        headers: [{ name: "Authorization", value: "Bearer fixture" }],
      },
    ])
    await expect(host.start({ sendOptions })).rejects.toThrow("Pause")
    await host.pause()
    jest.advanceTimersByTime(60_000)
    await flush()
    expect(call).toHaveBeenCalledWith("tool-host-start", {
      ownerSessionId: "chat-1",
      leaseId,
      renew: true,
    })
    expect(await host.start({ sendOptions: { ...sendOptions, allowedTools: ["read"] } })).toEqual(
      first
    )
    await host.close()
    await host.close()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    await expect(host.start({ sendOptions })).rejects.toThrow("closed")
  })

  it("scopes permission callbacks, denies by default, deduplicates frames and returns rewrites", async () => {
    const { host, call, emit } = setup()
    const onPermissionRequest = jest.fn(async () => ({
      decision: "allow_always" as const,
      updatedInput: { path: "safe.txt" },
    }))
    await host.start({ sendOptions, onPermissionRequest })
    emit(permission, { leaseId: "other" })
    emit(permission, { sessionId: "other" })
    emit({ ...permission, sessionId: "other" })
    emit(permission)
    emit(permission)
    await flush()
    expect(onPermissionRequest).toHaveBeenCalledTimes(1)
    expect(onPermissionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: `${RENDERER_TOOL_HOST_APPROVAL_PREFIX}${leaseId}:ask-1`,
      }),
      expect.any(AbortSignal)
    )
    expect(call).toHaveBeenCalledWith(
      "tool-host-reply",
      expect.objectContaining({
        kind: "permission",
        id: "ask-1",
        result: { behavior: "allow", updatedInput: { path: "safe.txt" } },
      })
    )
    await host.pause()
    await host.start({ sendOptions })
    emit(permission)
    await flush()
    expect(call).toHaveBeenLastCalledWith(
      "tool-host-reply",
      expect.objectContaining({
        result: { behavior: "deny", message: "Cognia tool permission denied" },
      })
    )
    await host.close()
  })

  it("uses the shared plugin executor and emits tool progress even if presentation throws", async () => {
    const { host, call, emit, execute } = setup()
    const onToolEvent = jest.fn(() => {
      throw new Error("UI unavailable")
    })
    await host.start({ sendOptions, onToolEvent })
    emit(plugin)
    await flush()
    expect(execute).toHaveBeenCalledWith({ ...plugin, abortSignal: expect.any(AbortSignal) })
    expect(onToolEvent.mock.calls).toHaveLength(3)
    expect(call).toHaveBeenLastCalledWith(
      "tool-host-reply",
      expect.objectContaining({
        kind: "plugin",
        id: "tool-2",
        result: expect.objectContaining({ result: "done" }),
      })
    )
    await host.close()
  })

  it("cancels pending execution and approvals on pause and ignores late responses", async () => {
    const { host, call, emit, execute } = setup()
    let finish!: (value: { decision: "allow" }) => void
    const onPermissionRequest = jest.fn(
      (_event, _signal) =>
        new Promise<{ decision: "allow" }>((resolve) => {
          finish = resolve
        })
    )
    await host.start({ sendOptions, onPermissionRequest })
    emit(permission)
    await flush()
    await host.pause()
    expect(onPermissionRequest.mock.calls[0][1].aborted).toBe(true)
    finish({ decision: "allow" })
    emit(plugin)
    await flush()
    expect(call.mock.calls.filter(([operation]) => operation === "tool-host-reply")).toHaveLength(0)
    expect(execute).not.toHaveBeenCalled()
    await host.start({ sendOptions })
    emit({ type: "tool_host_cancel", sessionId: "chat-1" })
    emit(plugin)
    await flush()
    expect(execute).not.toHaveBeenCalled()
    await host.close()
  })

  it("revokes a start which finishes after cancellation and releases the subscription", async () => {
    const { host, call, unsubscribe } = setup()
    let complete!: (value: unknown) => void
    call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const controller = new AbortController()
    const started = host.start({ sendOptions, signal: controller.signal })
    await flush()
    controller.abort()
    complete(descriptor)
    await expect(started).rejects.toMatchObject({ name: "AbortError" })
    await host.close()
    expect(call).toHaveBeenCalledWith("tool-host-stop", { ownerSessionId: "chat-1", leaseId })
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it.each([
    null,
    { ...descriptor, leaseId: "wrong" },
    { ...descriptor, mcpServers: [{ ...descriptor.mcpServers[0], url: "broken" }] },
    { ...descriptor, mcpServers: [{ ...descriptor.mcpServers[0], url: "https://remote.example" }] },
  ])("closes invalid startup descriptors", async (response) => {
    const { host, call } = setup()
    call.mockResolvedValueOnce(response)
    await expect(host.start({ sendOptions })).rejects.toThrow("invalid")
    expect(call).toHaveBeenCalledWith("tool-host-stop", expect.objectContaining({ leaseId }))
    await host.close()
  })

  it("fails closed when permission/execution handlers throw and heartbeat expires", async () => {
    const { host, call, emit, execute } = setup()
    execute.mockRejectedValueOnce(new Error("broken"))
    await host.start({
      sendOptions,
      onPermissionRequest: async () => {
        throw new Error("broken")
      },
    })
    emit(permission)
    emit(plugin)
    await flush()
    expect(call).toHaveBeenCalledWith(
      "tool-host-reply",
      expect.objectContaining({ result: { error: "Cognia tool execution failed" } })
    )
    call.mockRejectedValueOnce(new Error("lease expired"))
    jest.advanceTimersByTime(60_000)
    await flush()
    emit({ ...plugin, toolUseId: "new" })
    await flush()
    expect(execute).toHaveBeenCalledTimes(1)
    await host.close()
  })
})

it("binds hosted plugins to the actual container agent and excludes Host builtins", async () => {
  registerSpawnPlacement("container-agent", {
    kind: "container",
    isolationMandatory: true,
    spec: { specDigest: "sha256:fixture" },
  } as never)
  const { host, call } = setup()
  try {
    await host.start({ agentId: "container-agent", sendOptions })
    expect(call).toHaveBeenCalledWith(
      "tool-host-start",
      expect.objectContaining({ sandboxAgentId: "container-agent" })
    )
    const payload = call.mock.calls[0]![1] as { sendOptions?: Record<string, unknown> }
    expect(payload.sendOptions).not.toHaveProperty("builtinTools")
    expect(payload.sendOptions).not.toHaveProperty("cwd")
    await host.close()
  } finally {
    __resetSpawnPlacementsForTests()
  }
})

it("refuses a sandbox tool host before creating an unreachable endpoint", async () => {
  const { host, call } = setup()
  await expect(
    host.start({ sendOptions: { ...sendOptions, sandboxRuntimeRef: { id: "sandbox" } } as never })
  ).rejects.toThrow("does not support sandbox hosted tools")
  expect(call).not.toHaveBeenCalled()
  await host.close()
})

it("prepares an opaque plugin lease before the gateway child exists", async () => {
  registerSpawnPlacement("configured-agent", {
    kind: "container",
    isolationMandatory: true,
    spec: { specDigest: "fixture" },
  } as never)
  const { host, call } = setup()
  const sandboxToolHostLeaseId = "f268714a-4659-4b2e-b35a-c749c54e852e"
  call.mockResolvedValueOnce({ ...descriptor, sandboxToolHostLeaseId })
  try {
    await expect(
      host.start({ agentId: "configured-agent", deferSandbox: true, sendOptions })
    ).resolves.toMatchObject({ sandboxToolHostLeaseId })
    expect(call).toHaveBeenCalledWith(
      "tool-host-start",
      expect.objectContaining({ sandboxAgentId: "configured-agent", deferSandbox: true })
    )
    await host.pause()
    call.mockResolvedValueOnce(descriptor)
    await expect(
      host.start({ agentId: "configured-agent", deferSandbox: true, sendOptions })
    ).rejects.toThrow("sandbox plugin lease")
  } finally {
    await host.close()
    __resetSpawnPlacementsForTests()
  }
})

describe("remote renderer tool-host transport", () => {
  afterEach(() => {
    __resetRoutingForTests()
    jest.restoreAllMocks()
  })

  it("refuses older Hosts before transferring plugin metadata", () => {
    const target = { call: jest.fn(), subscribe: jest.fn() }
    setActiveRemoteTransport(target as Transport)
    jest.mocked(activeHostFeatureManifest).mockReturnValueOnce(null)
    expect(() => createRendererToolHost("chat")).toThrow("update the Host")
    expect(target.call).not.toHaveBeenCalled()
  })

  it("refuses sandbox tools when the Host only supports native tool hosting", async () => {
    const target = { call: jest.fn(), subscribe: jest.fn() }
    setActiveRemoteEndpoint({ hostId: "host-a", deviceId: "device-a" } as never)
    setActiveRemoteTransport(target as Transport)
    const host = createRendererToolHost("chat")
    await expect(
      host.start({
        agentId: "sandbox-agent",
        sendOptions: { ...sendOptions, sandboxRuntimeRef: { id: "sandbox" } } as never,
      })
    ).rejects.toThrow("does not support sandbox hosted tools")
    expect(target.call).not.toHaveBeenCalled()
    await host.close()
  })

  it("creates loopback MCP on the authenticated remote Host and refuses Host switching", async () => {
    jest.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000002")
    jest
      .mocked(callSidecarToolHost)
      .mockImplementation((operation, toolHost, request) =>
        request!({ operation, credentials: {}, toolHost })
      )
    const listeners = new Set<(payload: unknown) => void>()
    const target = {
      call: jest.fn(async (_command, args) => {
        const request = args.request
        const result =
          request.operation === "tool-host-start"
            ? { ...descriptor, leaseId: request.toolHost.leaseId }
            : {}
        for (const receive of listeners)
          receive({ type: "feature_call_result", requestId: request.requestId, result })
        return null
      }),
      subscribe: jest.fn((_event, handler) => {
        listeners.add(handler)
        return () => listeners.delete(handler)
      }),
      whenSubscribed: jest.fn(async () => {}),
    }
    setActiveRemoteEndpoint({ deviceId: "device-a" } as never)
    setActiveRemoteTransport(target as Transport)
    let toolSignal: AbortSignal | undefined
    let finishTool: ((value: never) => void) | undefined
    const host = createRendererToolHost("chat-remote", {
      execute: jest.fn((request) => {
        toolSignal = request.abortSignal
        return new Promise((resolve) => {
          finishTool = resolve
        })
      }),
    })
    const result = await host.start({ sendOptions })
    expect(result.mcpServers[0].name).toBe("cognia-tools")
    expect(target.call).toHaveBeenCalledWith("agent_tool_host_control", {
      request: expect.objectContaining({
        operation: "tool-host-start",
        toolHost: expect.objectContaining({
          leaseId: "remote-tool-host:device-a:00000000-0000-4000-8000-000000000002",
          ownerSessionId: "chat-remote",
        }),
      }),
    })
    expect(target.whenSubscribed).toHaveBeenCalledWith(["claude://message"])
    expect(target.call.mock.calls[0][1].request.toolHost.sendOptions).not.toHaveProperty("cwd")
    for (const receive of listeners)
      receive({
        type: "tool_host_event",
        sessionId: "chat-remote",
        generation: 1,
        leaseId: "remote-tool-host:device-a:00000000-0000-4000-8000-000000000002",
        event: {
          type: "plugin_tool_exec",
          sessionId: "chat-remote",
          toolUseId: "tool-1",
          name: "plugin",
          args: {},
        },
      })
    await flush()
    expect(toolSignal?.aborted).toBe(false)
    const other = { call: jest.fn(), subscribe: jest.fn() }
    setActiveRemoteTransport(other as Transport)
    expect(listeners.size).toBe(0)
    expect(toolSignal?.aborted).toBe(true)
    finishTool?.({ result: "late" } as never)
    await flush()
    await expect(host.pause()).rejects.toThrow("Host")
    await host.close().catch(() => undefined)
    expect(other.call).not.toHaveBeenCalled()
  })
})
