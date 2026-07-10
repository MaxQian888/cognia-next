/**
 * Tests for Plugin IPC
 */

import {
  PluginIPC,
  getPluginIPC,
  resetPluginIPC,
  createIPCAPI,
  CircuitOpenError,
  IPCAbortError,
} from "./ipc"
import { TimeoutError } from "@cognia/primitives"
import { PLUGIN_MESSAGE_HISTORY_MAX } from "./constants"
import { pluginHasApiPermission } from "@/lib/plugin/api/permission-api"

jest.mock("../contracts/diagnostics-store", () => ({
  recordSilentFailure: jest.fn(),
}))

// Default-allow so the existing createIPCAPI round-trip tests keep working;
// the gate tests flip it to false per-call.
jest.mock("@/lib/plugin/api/permission-api", () => ({
  pluginHasApiPermission: jest.fn(() => true),
}))
const mockHasPerm = pluginHasApiPermission as jest.MockedFunction<typeof pluginHasApiPermission>

// Lazy-imported by PluginIPC.tryResumeSuspendedTarget — mock the store +
// manager so the idle-suspend wake path is deterministic.
const mockResumePlugin = jest.fn<Promise<void>, [string, string?]>()
const mockPluginRecords: { value: Record<string, { status: string }> } = { value: {} }
jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: { getState: () => ({ plugins: mockPluginRecords.value }) },
}))
jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => ({ resumePlugin: mockResumePlugin }),
}))

beforeEach(() => {
  mockHasPerm.mockReturnValue(true)
})
// eslint-disable-next-line @typescript-eslint/no-require-imports
const diagModule = require("../contracts/diagnostics-store") as {
  recordSilentFailure: jest.Mock
}

describe("PluginIPC", () => {
  let ipc: PluginIPC

  beforeEach(() => {
    resetPluginIPC()
    ipc = new PluginIPC()
  })

  afterEach(() => {
    ipc.clear()
  })

  describe("Plugin Registration", () => {
    it("should register a plugin", () => {
      ipc.registerPlugin("plugin-a", [])
      expect(ipc.getExposedMethods("plugin-a")).toEqual([])
    })

    it("should unregister a plugin", () => {
      ipc.registerPlugin("plugin-a", [])
      ipc.unregisterPlugin("plugin-a")
      expect(ipc.getExposedMethods("plugin-a")).toEqual([])
    })
  })

  describe("Subscriptions", () => {
    it("should subscribe to a channel", () => {
      const handler = jest.fn()
      const unsubscribe = ipc.subscribe("plugin-a", "test-channel", handler)

      expect(typeof unsubscribe).toBe("function")
    })

    it("should receive messages on subscribed channel", async () => {
      const handler = jest.fn()
      ipc.subscribe("plugin-b", "test-channel", handler)

      await ipc.send("plugin-a", "plugin-b", "test-channel", { data: "test" })

      expect(handler).toHaveBeenCalledWith({ data: "test" }, "plugin-a")
    })

    it("should unsubscribe correctly", async () => {
      const handler = jest.fn()
      const unsubscribe = ipc.subscribe("plugin-b", "test-channel", handler)

      unsubscribe()

      await ipc.send("plugin-a", "plugin-b", "test-channel", { data: "test" })

      expect(handler).not.toHaveBeenCalled()
    })

    it("should filter messages by sender", async () => {
      const handler = jest.fn()
      ipc.subscribe("plugin-b", "test-channel", handler, (senderId) => senderId === "plugin-a")

      await ipc.send("plugin-a", "plugin-b", "test-channel", { data: "from-a" })
      await ipc.send("plugin-c", "plugin-b", "test-channel", { data: "from-c" })

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith({ data: "from-a" }, "plugin-a")
    })
  })

  describe("Broadcasting", () => {
    it("should broadcast to all subscribers except sender", () => {
      const handlerA = jest.fn()
      const handlerB = jest.fn()
      const handlerC = jest.fn()

      ipc.subscribe("plugin-a", "broadcast-channel", handlerA)
      ipc.subscribe("plugin-b", "broadcast-channel", handlerB)
      ipc.subscribe("plugin-c", "broadcast-channel", handlerC)

      ipc.broadcast("plugin-a", "broadcast-channel", { message: "hello" })

      expect(handlerA).not.toHaveBeenCalled()
      expect(handlerB).toHaveBeenCalledWith({ message: "hello" }, "plugin-a")
      expect(handlerC).toHaveBeenCalledWith({ message: "hello" }, "plugin-a")
    })
  })

  describe("RPC (expose/call)", () => {
    it("should expose methods", () => {
      ipc.expose("plugin-a", {
        greet: (name: unknown) => `Hello, ${name}!`,
        add: (a: unknown, b: unknown) => (a as number) + (b as number),
      })

      const methods = ipc.getExposedMethods("plugin-a")
      expect(methods).toContain("greet")
      expect(methods).toContain("add")
    })

    it("should call exposed methods", async () => {
      ipc.expose("plugin-a", {
        greet: (name: unknown) => `Hello, ${name}!`,
      })

      const result = await ipc.call<string>("plugin-b", "plugin-a", "greet", ["World"])
      expect(result).toBe("Hello, World!")
    })

    it("should call async exposed methods", async () => {
      ipc.expose("plugin-a", {
        asyncGreet: async (name: unknown) => {
          return `Hello, ${name}!`
        },
      })

      const result = await ipc.call<string>("plugin-b", "plugin-a", "asyncGreet", ["World"])
      expect(result).toBe("Hello, World!")
    })

    it("should throw error for non-existent method", async () => {
      ipc.expose("plugin-a", {})

      await expect(ipc.call("plugin-b", "plugin-a", "nonExistent")).rejects.toThrow(
        "Method nonExistent not found"
      )
    })

    it("should throw error for non-existent plugin", async () => {
      await expect(ipc.call("plugin-b", "plugin-unknown", "method")).rejects.toThrow(
        "Plugin plugin-unknown has no exposed methods"
      )
    })

    it("should unexpose methods", () => {
      ipc.expose("plugin-a", {
        greet: () => "Hello",
        bye: () => "Goodbye",
      })

      ipc.unexpose("plugin-a", "greet")
      const methods = ipc.getExposedMethods("plugin-a")

      expect(methods).not.toContain("greet")
      expect(methods).toContain("bye")
    })
  })

  describe("RPC schema validation + discovery", () => {
    it("validates args against a declared method schema before invoking the handler", async () => {
      const handler = jest.fn((a: unknown, b: unknown) => (a as number) + (b as number))
      ipc.expose("plugin-a", {
        add: {
          handler,
          schema: {
            description: "Add two numbers",
            args: [{ type: "number" }, { type: "number" }],
          },
        },
      })

      // Valid call passes through.
      await expect(ipc.call("plugin-b", "plugin-a", "add", [2, 3])).resolves.toBe(5)

      // Wrong type is rejected before the handler runs.
      handler.mockClear()
      await expect(ipc.call("plugin-b", "plugin-a", "add", [2, "oops"])).rejects.toThrow(
        /argument 1 expected type "number"/
      )
      expect(handler).not.toHaveBeenCalled()

      // Too few args.
      await expect(ipc.call("plugin-b", "plugin-a", "add", [2])).rejects.toThrow(
        /expected at least 2 argument/
      )
      // Too many args.
      await expect(ipc.call("plugin-b", "plugin-a", "add", [2, 3, 4])).rejects.toThrow(
        /expected at most 2 argument/
      )
    })

    it("treats trailing optional args as omittable", async () => {
      ipc.expose("plugin-a", {
        greet: {
          handler: (name: unknown, suffix: unknown) => `Hi ${name}${suffix ?? ""}`,
          schema: { args: [{ type: "string" }, { type: "string", optional: true }] },
        },
      })

      await expect(ipc.call("plugin-b", "plugin-a", "greet", ["Ada"])).resolves.toBe("Hi Ada")
      await expect(ipc.call("plugin-b", "plugin-a", "greet", ["Ada", "!"])).resolves.toBe("Hi Ada!")
    })

    it("a schema violation never charges the endpoint breaker", async () => {
      ipc.expose("plugin-a", {
        strict: {
          handler: () => "ok",
          schema: { args: [{ type: "string" }] },
        },
      })

      // Six invalid calls — if these counted as failures the breaker would open.
      for (let i = 0; i < 6; i++) {
        await expect(ipc.call("plugin-b", "plugin-a", "strict", [123])).rejects.toThrow(
          /argument 0 expected type "string"/
        )
      }
      // Validation short-circuits before getBreaker(), so no breaker is even
      // instantiated — and certainly not opened.
      expect(ipc.getBreakerState("plugin-a", "strict")).toBeNull()
      // A valid call still works (and now creates a healthy breaker).
      await expect(ipc.call("plugin-b", "plugin-a", "strict", ["hi"])).resolves.toBe("ok")
      expect(ipc.getBreakerState("plugin-a", "strict")).toBe("closed")
    })

    it("describes exposed methods for service discovery without leaking handlers", () => {
      ipc.expose("plugin-a", {
        bare: () => "x",
        documented: {
          handler: () => "y",
          description: "Does a thing",
          schema: { args: [{ type: "string" }] },
        },
      })

      const described = ipc.describeExposedMethods("plugin-a")
      expect(described).toEqual(
        expect.arrayContaining([
          { name: "bare", description: undefined, schema: undefined },
          {
            name: "documented",
            description: "Does a thing",
            schema: { args: [{ type: "string" }] },
          },
        ])
      )
      // No handler field is exposed.
      expect(described.every((m) => !("handler" in m))).toBe(true)
      expect(ipc.describeExposedMethods("plugin-unknown")).toEqual([])
    })
  })

  describe("call() size cap", () => {
    it("rejects args exceeding maxMessageSize before dispatch (no breaker charge)", async () => {
      const small = new PluginIPC({ maxMessageSize: 16 })
      const handler = jest.fn(() => "ok")
      small.expose("plugin-a", { echo: handler })
      await expect(small.call("plugin-b", "plugin-a", "echo", ["x".repeat(64)])).rejects.toThrow(
        /exceeds maximum/
      )
      expect(handler).not.toHaveBeenCalled()
      small.clear()
    })

    it("allows args within maxMessageSize", async () => {
      const small = new PluginIPC({ maxMessageSize: 1024 })
      small.expose("plugin-a", { echo: (s: unknown) => s })
      await expect(small.call("plugin-b", "plugin-a", "echo", ["hi"])).resolves.toBe("hi")
      small.clear()
    })
  })

  describe("idle-suspend wake on call()", () => {
    beforeEach(() => {
      mockResumePlugin.mockReset()
      mockPluginRecords.value = {}
    })

    it("resumes a suspended target and retries the lookup once", async () => {
      mockPluginRecords.value = { "plugin-a": { status: "suspended" } }
      // Simulate resumePlugin re-running activate() → re-exposing the method.
      mockResumePlugin.mockImplementation(async () => {
        ipc.expose("plugin-a", { greet: () => "awake" })
      })
      await expect(ipc.call("plugin-b", "plugin-a", "greet")).resolves.toBe("awake")
      expect(mockResumePlugin).toHaveBeenCalledWith("plugin-a", "ipc-call")
    })

    it("does not resume when the target is not suspended and throws normally", async () => {
      mockPluginRecords.value = { "plugin-a": { status: "enabled" } }
      await expect(ipc.call("plugin-b", "plugin-a", "greet")).rejects.toThrow(
        "Plugin plugin-a has no exposed methods"
      )
      expect(mockResumePlugin).not.toHaveBeenCalled()
    })

    it("still throws if the resume does not re-expose the method", async () => {
      mockPluginRecords.value = { "plugin-a": { status: "suspended" } }
      mockResumePlugin.mockResolvedValue(undefined)
      await expect(ipc.call("plugin-b", "plugin-a", "greet")).rejects.toThrow(
        "Plugin plugin-a has no exposed methods"
      )
      expect(mockResumePlugin).toHaveBeenCalled()
    })
  })

  describe("Message History", () => {
    it("should record message history", async () => {
      await ipc.send("plugin-a", "plugin-b", "channel", { data: 1 })
      await ipc.send("plugin-a", "plugin-b", "channel", { data: 2 })

      const history = ipc.getMessageHistory()
      expect(history.length).toBe(2)
    })

    it("should filter history by channel", async () => {
      await ipc.send("plugin-a", "plugin-b", "channel-1", { data: 1 })
      await ipc.send("plugin-a", "plugin-b", "channel-2", { data: 2 })

      const history = ipc.getMessageHistory({ channel: "channel-1" })
      expect(history.length).toBe(1)
      expect(history[0].channel).toBe("channel-1")
    })

    it("should filter history by plugin", async () => {
      await ipc.send("plugin-a", "plugin-b", "channel", { data: 1 })
      await ipc.send("plugin-c", "plugin-d", "channel", { data: 2 })

      const history = ipc.getMessageHistory({ pluginId: "plugin-a" })
      expect(history.length).toBe(1)
    })
  })

  describe("Stats", () => {
    it("should return correct stats", () => {
      ipc.subscribe("plugin-a", "channel-1", () => {})
      ipc.subscribe("plugin-b", "channel-2", () => {})
      ipc.expose("plugin-a", { method1: () => {} })

      const stats = ipc.getStats()
      expect(stats.totalSubscriptions).toBe(2)
      expect(stats.totalExposedMethods).toBe(1)
    })
  })

  describe("call timeout", () => {
    it("rejects with TimeoutError when the handler outlasts the budget", async () => {
      jest.useFakeTimers()
      try {
        ipc.expose("plugin-a", {
          slow: async () => {
            await new Promise((r) => setTimeout(r, 5000))
            return "late"
          },
        })
        const pending = ipc.call("plugin-b", "plugin-a", "slow", [], { timeoutMs: 100 })
        jest.advanceTimersByTime(100)
        await expect(pending).rejects.toBeInstanceOf(TimeoutError)
      } finally {
        jest.useRealTimers()
      }
    })

    it("resolves normally when the handler beats the budget", async () => {
      ipc.expose("plugin-a", {
        fast: async () => "ok",
      })
      await expect(ipc.call("plugin-b", "plugin-a", "fast", [], { timeoutMs: 1000 })).resolves.toBe(
        "ok"
      )
    })

    it("disables the timer when timeoutMs is non-positive", async () => {
      ipc.expose("plugin-a", {
        echo: (value: unknown) => value,
      })
      await expect(
        ipc.call("plugin-b", "plugin-a", "echo", ["passthrough"], { timeoutMs: 0 })
      ).resolves.toBe("passthrough")
    })
  })

  describe("call AbortSignal", () => {
    it("rejects with IPCAbortError when the signal is already aborted", async () => {
      ipc.expose("plugin-a", { ping: async () => "pong" })
      const controller = new AbortController()
      controller.abort()
      await expect(
        ipc.call("plugin-b", "plugin-a", "ping", [], { signal: controller.signal })
      ).rejects.toBeInstanceOf(IPCAbortError)
    })

    it("rejects mid-flight when the signal fires during the call", async () => {
      ipc.expose("plugin-a", {
        slow: async () => {
          await new Promise((r) => setTimeout(r, 1000))
          return "late"
        },
      })
      const controller = new AbortController()
      const pending = ipc.call("plugin-b", "plugin-a", "slow", [], { signal: controller.signal })
      // Fire abort on the next tick so the listener is wired before we cancel.
      setTimeout(() => controller.abort(), 0)
      await expect(pending).rejects.toBeInstanceOf(IPCAbortError)
    })

    it("does not charge the breaker for caller-aborted calls", async () => {
      ipc.expose("plugin-a", {
        slow: async () => {
          await new Promise((r) => setTimeout(r, 1000))
          return "late"
        },
      })
      const controller = new AbortController()
      controller.abort()
      for (let i = 0; i < 10; i += 1) {
        await ipc
          .call("plugin-b", "plugin-a", "slow", [], { signal: controller.signal })
          .catch(() => {})
      }
      // Breaker should stay closed because aborts don't recordFailure.
      expect(ipc.getBreakerState("plugin-a", "slow")).toBe("closed")
    })
  })

  describe("circuit breaker", () => {
    beforeEach(() => {
      diagModule.recordSilentFailure.mockReset()
    })

    it("trips after enough consecutive failures and short-circuits subsequent calls", async () => {
      // Tighten the breaker so the test stays fast.
      ipc.expose("plugin-a", {
        flaky: async () => {
          throw new Error("provider error")
        },
      })
      // Default config: needs ≥5 events within 30s and ≥50% failure rate.
      // We push 5 failures to flip the breaker.
      for (let i = 0; i < 5; i += 1) {
        await ipc.call("plugin-b", "plugin-a", "flaky").catch(() => {})
      }
      expect(ipc.getBreakerState("plugin-a", "flaky")).toBe("open")
      // Next call short-circuits without invoking the handler.
      await expect(ipc.call("plugin-b", "plugin-a", "flaky")).rejects.toBeInstanceOf(
        CircuitOpenError
      )
    })

    it("emits one recordSilentFailure on the closed→open transition", async () => {
      ipc.expose("plugin-a", {
        flaky: async () => {
          throw new Error("provider error")
        },
      })
      for (let i = 0; i < 5; i += 1) {
        await ipc.call("plugin-b", "plugin-a", "flaky").catch(() => {})
      }
      // The trip itself is one call; subsequent rejections shouldn't
      // re-emit on the same `open` state.
      await ipc.call("plugin-b", "plugin-a", "flaky").catch(() => {})
      await ipc.call("plugin-b", "plugin-a", "flaky").catch(() => {})
      expect(
        diagModule.recordSilentFailure.mock.calls.filter(
          ([, info]) => (info as { site: string }).site === "ipc.circuit-open"
        )
      ).toHaveLength(1)
    })

    it("isolates breakers per (pluginId, methodName)", async () => {
      ipc.expose("plugin-a", {
        flaky: async () => {
          throw new Error("provider error")
        },
        healthy: async () => "ok",
      })
      for (let i = 0; i < 5; i += 1) {
        await ipc.call("plugin-b", "plugin-a", "flaky").catch(() => {})
      }
      expect(ipc.getBreakerState("plugin-a", "flaky")).toBe("open")
      // Healthy endpoint untouched.
      await expect(ipc.call("plugin-b", "plugin-a", "healthy")).resolves.toBe("ok")
      expect(ipc.getBreakerState("plugin-a", "healthy")).toBe("closed")
    })
  })

  describe("Message History (unified cap)", () => {
    it("defaults history cap to PLUGIN_MESSAGE_HISTORY_MAX", async () => {
      // Push more than the legacy 100-item cap and confirm history retains 101.
      for (let i = 0; i < 101; i += 1) {
        await ipc.send("plugin-a", "plugin-b", "channel", { data: i })
      }
      const history = ipc.getMessageHistory()
      expect(history.length).toBe(101)
      expect(PLUGIN_MESSAGE_HISTORY_MAX).toBeGreaterThanOrEqual(500)
    })

    it("honours an explicit per-instance maxHistory override", async () => {
      const tinyIpc = new PluginIPC({ maxHistory: 3 })
      try {
        for (let i = 0; i < 10; i += 1) {
          await tinyIpc.send("plugin-a", "plugin-b", "channel", { data: i })
        }
        expect(tinyIpc.getMessageHistory().length).toBe(3)
      } finally {
        tinyIpc.clear()
      }
    })
  })
})

describe("createIPCAPI", () => {
  beforeEach(() => {
    resetPluginIPC()
  })

  it("should create an IPC API for a plugin", () => {
    const api = createIPCAPI("my-plugin")

    expect(api.send).toBeDefined()
    expect(api.broadcast).toBeDefined()
    expect(api.on).toBeDefined()
    expect(api.expose).toBeDefined()
    expect(api.call).toBeDefined()
    expect(api.getExposedMethods).toBeDefined()
    expect(api.describeExposedMethods).toBeDefined()
  })

  it("gates service discovery (describeExposedMethods) behind ipc:call (W3.5)", () => {
    getPluginIPC().expose("plugin-b", {
      ping: { handler: () => "pong", description: "health check" },
    })
    mockHasPerm.mockReturnValue(false)
    const api = createIPCAPI("plugin-a")
    expect(() => api.describeExposedMethods("plugin-b")).toThrow(/ipc:call/)

    mockHasPerm.mockReturnValue(true)
    const described = api.describeExposedMethods("plugin-b")
    expect(described).toEqual([{ name: "ping", description: "health check", schema: undefined }])
  })

  it("should send messages using the API", async () => {
    const api = createIPCAPI("plugin-a")
    const ipc = getPluginIPC()
    const handler = jest.fn()

    ipc.subscribe("plugin-b", "test", handler)
    await api.send("plugin-b", "test", { hello: "world" })

    expect(handler).toHaveBeenCalledWith({ hello: "world" }, "plugin-a")
  })

  describe("permission gate", () => {
    it("rejects call/send/broadcast without ipc:call", async () => {
      mockHasPerm.mockImplementation((_id, perm) => perm !== "ipc:call")
      const api = createIPCAPI("plugin-a")

      await expect(api.call("plugin-b", "m")).rejects.toThrow(/ipc:call/)
      await expect(api.send("plugin-b", "c", {})).rejects.toThrow(/ipc:call/)
      expect(() => api.broadcast("c", {})).toThrow(/ipc:call/)
    })

    it("rejects expose without ipc:expose", () => {
      mockHasPerm.mockImplementation((_id, perm) => perm !== "ipc:expose")
      const api = createIPCAPI("plugin-a")
      expect(() => api.expose({ ping: () => "pong" })).toThrow(/ipc:expose/)
    })

    it("allows the call once ipc:call is granted", async () => {
      mockHasPerm.mockReturnValue(true)
      const exposer = createIPCAPI("plugin-b")
      exposer.expose({ add: (a, b) => (a as number) + (b as number) })

      const caller = createIPCAPI("plugin-a")
      await expect(caller.call<number>("plugin-b", "add", [2, 3])).resolves.toBe(5)
    })

    it("leaves on() ungated but gates enumeration behind ipc:call (W3.5)", () => {
      mockHasPerm.mockReturnValue(false)
      const api = createIPCAPI("plugin-a")
      expect(() => api.on("c", () => {})).not.toThrow()
      expect(() => api.getExposedMethods("plugin-b")).toThrow(/ipc:call/)
    })
  })
})

describe("Singleton", () => {
  it("should return the same instance", () => {
    resetPluginIPC()
    const instance1 = getPluginIPC()
    const instance2 = getPluginIPC()
    expect(instance1).toBe(instance2)
  })

  it("should reset the singleton", () => {
    const instance1 = getPluginIPC()
    resetPluginIPC()
    const instance2 = getPluginIPC()
    expect(instance1).not.toBe(instance2)
  })
})

describe("createIPCAPI new options", () => {
  beforeEach(() => {
    resetPluginIPC()
  })

  it("forwards args + options to the underlying PluginIPC.call", async () => {
    const api = createIPCAPI("plugin-a")
    const ipc = getPluginIPC()
    ipc.expose("plugin-b", { add: (a: unknown, b: unknown) => (a as number) + (b as number) })

    const result = await api.call<number>("plugin-b", "add", [2, 3])
    expect(result).toBe(5)
  })

  it("forwards AbortSignal through the API wrapper", async () => {
    const api = createIPCAPI("plugin-a")
    const ipc = getPluginIPC()
    ipc.expose("plugin-b", {
      slow: async () => {
        await new Promise((r) => setTimeout(r, 1000))
      },
    })
    const controller = new AbortController()
    controller.abort()
    await expect(api.call("plugin-b", "slow", [], { signal: controller.signal })).rejects.toThrow(
      /aborted/i
    )
  })
})

// ── W3.5/W3.6: target-side ACL, scoped broadcast, owned channels ─────────────
describe("IPC hardening (W3.5/W3.6)", () => {
  let ipc: PluginIPC

  beforeEach(() => {
    resetPluginIPC()
    ipc = getPluginIPC()
    mockHasPerm.mockReturnValue(true)
  })

  it("enforces the exposer's allowedCallers on call()", async () => {
    ipc.expose("provider", {
      secret: { handler: () => 42, allowedCallers: ["friend"] },
    })
    await expect(ipc.call("friend", "provider", "secret")).resolves.toBe(42)
    await expect(ipc.call("stranger", "provider", "secret")).rejects.toThrow(
      /does not allow calls from "stranger"/
    )
    // The owner can always call itself.
    await expect(ipc.call("provider", "provider", "secret")).resolves.toBe(42)
  })

  it("filters enumeration to methods the caller may invoke", () => {
    ipc.expose("provider", {
      open: () => 1,
      restricted: { handler: () => 2, allowedCallers: ["friend"] },
    })
    expect(ipc.getExposedMethods("provider", "friend")).toEqual(["open", "restricted"])
    expect(ipc.getExposedMethods("provider", "stranger")).toEqual(["open"])
    expect(ipc.describeExposedMethods("provider", "stranger").map((m) => m.name)).toEqual(["open"])
  })

  it("restricts broadcast delivery to the `to` allowlist", () => {
    const friend = jest.fn()
    const eavesdropper = jest.fn()
    ipc.subscribe("friend", "news", friend)
    ipc.subscribe("eavesdropper", "news", eavesdropper)

    ipc.broadcast("sender", "news", { x: 1 }, { to: ["friend"] })
    expect(friend).toHaveBeenCalledWith({ x: 1 }, "sender")
    expect(eavesdropper).not.toHaveBeenCalled()

    ipc.broadcast("sender", "news", { x: 2 })
    expect(eavesdropper).toHaveBeenCalledWith({ x: 2 }, "sender")
  })

  it("blocks publishing on another registered plugin's owned channel", () => {
    ipc.registerPlugin("owner")
    expect(() => ipc.broadcast("intruder", "owner:events", {})).toThrow(/owned by plugin "owner"/)
    // The owner itself and non-plugin prefixes stay allowed.
    expect(() => ipc.broadcast("owner", "owner:events", {})).not.toThrow()
    expect(() => ipc.broadcast("intruder", "weather:today", {})).not.toThrow()
  })

  it("evicts a plugin's breakers on unregisterPlugin (W3.7)", async () => {
    ipc.expose("flaky", {
      boom: () => {
        throw new Error("boom")
      },
    })
    await expect(ipc.call("caller", "flaky", "boom")).rejects.toThrow()
    expect(ipc.getBreakerState("flaky", "boom")).not.toBeNull()
    ipc.unregisterPlugin("flaky")
    expect(ipc.getBreakerState("flaky", "boom")).toBeNull()
  })

  it("gates the idle-target force-wake behind the caller's ipc:call", async () => {
    // Registered plugin without ipc:call must not trigger the wake path —
    // the lookup just fails with the normal error.
    ipc.registerPlugin("powerless")
    mockHasPerm.mockReturnValue(false)
    await expect(ipc.call("powerless", "sleeping-target", "m")).rejects.toThrow(
      /no exposed methods/
    )
  })
})
