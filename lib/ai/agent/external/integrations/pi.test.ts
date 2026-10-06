import type { AgentProcessHost } from "@cognia/agent-contracts/host"
import { PI_RPC_EXECUTION_SEMANTICS } from "@cognia/agent-pi/manifest"
import { PiRpcClientAdapter, type PiHostServices } from "@cognia/agent-pi/rpc-client"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { matchGlob } from "@/lib/claude/permissions/ruleset"
import { LeaseConflictError } from "@/lib/execution/lease-conflict"
import { configuredApprovalPolicy } from "../policy/tool-preapproval"
import { createPiRpcAdapter, createPiRpcAdapterFactory, resolvePluginPiPackages } from "./pi"
import cogniaPiExtension from "../../../../../sidecar/pi-extension/cognia-pi-extension"
import {
  PI_BUILTIN_TOOLS,
  PI_PERMISSION_MARKER,
  decidePiTool,
  decodePiPermissionTitle,
  decodePiToolPolicy,
  PI_PERMISSION_INPUT_LIMIT,
  encodePiToolPolicy,
  resolvePiToolPolicy,
} from "@cognia/agent-pi/permission"

const mockResolveHosted = jest.fn(async () => [])
jest.mock("@/lib/plugin/pi-packages/session", () => ({
  resolveHostedPiPackages: (...args: unknown[]) => mockResolveHosted(...(args as [])),
}))

function processHost(): jest.Mocked<AgentProcessHost> {
  const host: AgentProcessHost = {
    available: true,
    spawn: jest.fn(async (spec) => spec.id),
    send: jest.fn(async () => undefined),
    kill: jest.fn(async () => undefined),
    commandExists: jest.fn(async () => true),
    onStdoutLine: jest.fn(async () => () => undefined),
    onStdoutRaw: jest.fn(async () => () => undefined),
    onStderr: jest.fn(async () => () => undefined),
    onExit: jest.fn(async () => () => undefined),
  }
  return host as jest.Mocked<AgentProcessHost>
}

const services: PiHostServices = {
  resolveExtension: async () => ({ status: "missing" }),
  listSessions: async () => [],
}

describe("Pi host wiring", () => {
  it("builds the pi-rpc adapter with per-session, turn-cancel semantics", () => {
    const adapter = createPiRpcAdapterFactory(processHost(), services)()
    expect(adapter).toBeInstanceOf(PiRpcClientAdapter)
    expect(adapter.protocol).toBe("pi-rpc")
    expect(adapter.semantics).toBe(PI_RPC_EXECUTION_SEMANTICS)
  })

  it("lists stored sessions through the host services it was built with", async () => {
    const listSessions = jest.fn(async () => [{ id: "s1", cwd: "/w", updatedAt: "2026-01-01" }])
    const adapter = createPiRpcAdapter(processHost(), { ...services, listSessions })
    await expect(adapter.listSessions({ cwd: "/w" })).resolves.toEqual([
      { sessionId: "s1", cwd: "/w", updatedAt: "2026-01-01" },
    ])
    expect(listSessions).toHaveBeenCalledWith("/w")
  })

  it("resolves plugin Pi packages from the plugin registry, lazily", async () => {
    const context = { extensionPolicy: "isolated" as const }
    await resolvePluginPiPackages(["plugin/pkg"], context)
    expect(mockResolveHosted).toHaveBeenCalledWith(["plugin/pkg"], context)
  })

  it("maps a held process id onto the app's lease conflict", async () => {
    const host = processHost()
    host.spawn.mockRejectedValue(new Error("Agent agent-1:sess-1 is already running"))
    const adapter = createPiRpcAdapter(host, {
      ...services,
      resolveExtension: async () => ({ status: "ok", path: "/ext.ts", sha256: "x" }),
    }) as unknown as {
      classifySpawnConflict: (error: unknown) => Error | null
    }
    expect(adapter.classifySpawnConflict(new Error("Agent a:b is already running"))).toBeInstanceOf(
      LeaseConflictError
    )
    expect(adapter.classifySpawnConflict(new Error("other"))).toBeNull()
  })

  it("hands the adapter the app's PII gate, approval policy and approval-list glob", () => {
    const adapter = createPiRpcAdapter(processHost(), services) as unknown as Record<
      string,
      unknown
    >
    expect(adapter.outboundGate).toBe(hasNoLeakingPiiDeep)
    expect(adapter.approvalPolicy).toBe(configuredApprovalPolicy)
    expect(adapter.matchToolPattern).toBe(matchGlob)
  })

  it("creates an independent adapter per configuration", () => {
    const factory = createPiRpcAdapterFactory(processHost(), services)
    expect(factory()).not.toBe(factory())
  })
})

/**
 * Drift guard for the shipped extension.
 *
 * `sidecar/` is outside the root tsconfig and outside Jest's test discovery,
 * so the extension carries its own copy of the policy READER (it cannot import
 * from `@/lib`). Jest can still import that file, which lets the two
 * implementations be pinned to each other here — without this, the extension's
 * parser could quietly stop agreeing with the table it is meant to apply.
 */
describe("bundled extension parity", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const extension = require("../../../../../sidecar/pi-extension/cognia-pi-extension") as {
    __readPolicyForTests?: (raw: string | undefined) => {
      decisions: Record<string, string>
      fallback: string
    }
    __markerPayloadForTests?: (
      toolName: string,
      mode: string,
      input: Record<string, unknown> | undefined
    ) => Record<string, unknown>
    COGNIA_PI_EXTENSION_VERSION: number
    COGNIA_PERMISSION_MARKER: string
  }

  it("exposes a version the adapter's handshake can assert", () => {
    expect(typeof extension.COGNIA_PI_EXTENSION_VERSION).toBe("number")
  })

  /**
   * If these drift, every native-tool approval silently degrades into a generic
   * elicitation form: the allow/deny/allow-always affordances and the approval
   * audit trail disappear, and nothing errors.
   */
  it("uses the same approval marker the mapper matches on", () => {
    expect(extension.COGNIA_PERMISSION_MARKER).toBe(PI_PERMISSION_MARKER)
  })

  it("sends an approval payload the app-side decoder reads back whole", () => {
    const build = extension.__markerPayloadForTests
    if (!build) throw new Error("extension did not export its payload builder for testing")

    const decoded = decodePiPermissionTitle(
      `${PI_PERMISSION_MARKER} ${JSON.stringify(build("bash", "acceptEdits", { command: "ls" }))}`
    )
    expect(decoded).toEqual({ tool: "bash", mode: "acceptEdits", input: { command: "ls" } })
  })

  it("applies the same input ceiling the app-side encoder does", () => {
    // Two copies of one limit: if the extension's were the larger, it would send
    // a frame the decoder accepts but the transport should never have carried.
    const build = extension.__markerPayloadForTests!
    const huge = { content: "x".repeat(PI_PERMISSION_INPUT_LIMIT + 1) }
    expect(build("write", "default", huge)).toEqual({ tool: "write", mode: "default" })
    const justFits = { content: "x".repeat(PI_PERMISSION_INPUT_LIMIT - 100) }
    expect(build("write", "default", justFits)).toEqual({
      tool: "write",
      mode: "default",
      input: justFits,
    })
  })

  it("reads a policy identically to the app-side decoder", () => {
    const read = extension.__readPolicyForTests
    if (!read) throw new Error("extension did not export its policy reader for testing")

    for (const mode of ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"]) {
      const encoded = encodePiToolPolicy(resolvePiToolPolicy(mode, ["read"]))
      const app = decodePiToolPolicy(encoded)
      const shipped = read(encoded)
      for (const tool of [...PI_BUILTIN_TOOLS, "unknown_extension_tool"]) {
        expect(shipped.decisions[tool] ?? shipped.fallback).toBe(decidePiTool(app, tool))
      }
    }
  })

  it("fails closed on an unreadable policy, exactly as the app decoder does", () => {
    const read = extension.__readPolicyForTests!
    for (const raw of [undefined, "", "not json", "[1,2]"]) {
      const shipped = read(raw)
      const app = decodePiToolPolicy(raw)
      // Deny-everything, so a broken handshake can never widen access — and
      // asserted against the app decoder rather than against a literal, so the
      // two cannot drift apart again the way they had.
      for (const tool of [...PI_BUILTIN_TOOLS, "unknown_extension_tool"]) {
        expect(shipped.decisions[tool] ?? shipped.fallback).toBe("deny")
        expect(decidePiTool(app, tool)).toBe("deny")
      }
    }
  })
})

describe("bundled native tool approval blocking", () => {
  type Api = Parameters<typeof cogniaPiExtension>[0]
  type Handler = Parameters<Api["on"]>[1]
  type Context = Parameters<Handler>[1]

  function gate(confirm: Context["ui"]["confirm"]) {
    const handlers = new Map<string, Handler>()
    const previous = process.env.COGNIA_TOOLHOST_PI_POLICY
    process.env.COGNIA_TOOLHOST_PI_POLICY = encodePiToolPolicy(resolvePiToolPolicy("default"))
    try {
      cogniaPiExtension({
        on: (event, handler) => {
          handlers.set(event, handler)
        },
        registerTool: jest.fn(),
      })
    } finally {
      if (previous === undefined) delete process.env.COGNIA_TOOLHOST_PI_POLICY
      else process.env.COGNIA_TOOLHOST_PI_POLICY = previous
    }
    const controller = new AbortController()
    const ctx = {
      hasUI: true,
      signal: controller.signal,
      ui: { confirm, notify: jest.fn(), setStatus: jest.fn() },
    }
    return {
      controller,
      call: (toolName: string) =>
        Promise.resolve(handlers.get("tool_call")!({ toolName } as never, ctx)),
    }
  }

  it("keeps the hook and following read blocked until the user answers", async () => {
    let answer!: (value: boolean) => void
    const confirm = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve
        })
    )
    const { call } = gate(confirm)
    const completed = jest.fn()
    const bash = call("bash").then(completed)
    const read = call("read").then(completed)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(completed).not.toHaveBeenCalled()
    answer(true)
    await Promise.all([bash, read])
    expect(completed.mock.calls).toEqual([[undefined], [undefined]])
  })

  it("blocks a turn that was already cancelled without opening a dialog", async () => {
    const confirm = jest.fn(async () => true)
    const { call, controller } = gate(confirm)
    controller.abort()
    await expect(call("bash")).resolves.toMatchObject({ block: true })
    await expect(call("read")).resolves.toMatchObject({ block: true })
    expect(confirm).not.toHaveBeenCalled()
  })

  it("blocks a failed approval and allows the next request to ask again", async () => {
    const confirm = jest
      .fn()
      .mockRejectedValueOnce(new Error("UI failed"))
      .mockResolvedValueOnce(false)
    const { call } = gate(confirm)
    await expect(call("bash")).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining("UI failed"),
    })
    await expect(call("write")).resolves.toMatchObject({
      block: true,
      reason: "Denied by the user",
    })
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it("does not allow a late yes or a queued read after cancellation", async () => {
    let answer!: (value: boolean) => void
    const { call, controller } = gate(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve
        })
    )
    const bash = call("bash")
    const read = call("read")
    await Promise.resolve()
    controller.abort()
    answer(true)
    await expect(bash).resolves.toMatchObject({ block: true })
    await expect(read).resolves.toMatchObject({ block: true })
  })

  it("passes the turn signal to pi and never opens a queued approval after abort", async () => {
    const confirm = jest.fn<
      ReturnType<Context["ui"]["confirm"]>,
      Parameters<Context["ui"]["confirm"]>
    >()
    confirm.mockImplementation(
      (_title, _message, options) =>
        new Promise<boolean>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(false), { once: true })
        })
    )
    const { call, controller } = gate(confirm)
    const first = call("bash")
    const queued = call("write")
    await Promise.resolve()
    const passedSignal = confirm.mock.calls[0]?.[2]?.signal
    controller.abort()
    // Check the actual RPC cancellation contract before awaiting the hook.
    expect(passedSignal).toBe(controller.signal)
    await expect(first).resolves.toMatchObject({ block: true })
    await expect(queued).resolves.toMatchObject({ block: true })
    expect(confirm).toHaveBeenCalledTimes(1)
  })
})

describe("protocol registration", () => {
  /**
   * The `dsh-sdk` trap this integration had to avoid: a protocol can be in the
   * type union, the permission table, the supported list and a preset while
   * `registerDefaultAdapters()` never registers its adapter — so `addAgent`
   * throws `Unsupported protocol` only at the point of use. Importing the
   * manager here proves the registration actually ran.
   */
  it("is registered as a built-in adapter, not merely declared", async () => {
    const { protocolAdapterRegistry } = await import("../protocol-adapter")
    await import("../manager")
    const { ExternalAgentManager } = await import("../manager")
    ExternalAgentManager.getInstance()

    expect(protocolAdapterRegistry.has("pi-rpc")).toBe(true)
    expect(protocolAdapterRegistry.create("pi-rpc")?.protocol).toBe("pi-rpc")
  })

  it("declares itself in the supported protocol list", async () => {
    const { SUPPORTED_EXTERNAL_AGENT_PROTOCOLS } = await import("../config/config-normalizer")
    expect([...SUPPORTED_EXTERNAL_AGENT_PROTOCOLS]).toContain("pi-rpc")
  })
})
