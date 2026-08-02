import type { SandboxLifecycleState } from "@/types/sandbox"
import { defaultSandboxCapabilities } from "./connection-capabilities"
import {
  SandboxCapabilityError,
  assertSandboxOperationAllowed,
  runSandboxOperation,
  type SandboxOperationContext,
  type SandboxProviderAdapter,
} from "./lifecycle-contract"

function ctx(overrides: Partial<SandboxOperationContext> = {}): SandboxOperationContext {
  return {
    connectionId: "conn-1",
    provider: "docker",
    driver: "cua-driver",
    capabilities: defaultSandboxCapabilities("docker", "cua-driver"),
    state: "running",
    ...overrides,
  }
}

describe("assertSandboxOperationAllowed", () => {
  it("allows a supported operation in a valid state", () => {
    expect(() => assertSandboxOperationAllowed(ctx(), "stop")).not.toThrow()
  })

  it("refuses an unsupported operation with unsupported-operation", () => {
    try {
      assertSandboxOperationAllowed(ctx(), "suspend")
      throw new Error("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxCapabilityError)
      const e = err as SandboxCapabilityError
      expect(e.code).toBe("unsupported-operation")
      expect(e.operation).toBe("suspend")
      expect(e.provider).toBe("docker")
      expect(e.driver).toBe("cua-driver")
      expect(e.message).toContain("suspend")
      expect(e.message).toContain("docker")
    }
  })

  it("refuses a supported operation in a forbidden state", () => {
    try {
      assertSandboxOperationAllowed(ctx({ state: "stopped" }), "gui")
      throw new Error("should have thrown")
    } catch (err) {
      const e = err as SandboxCapabilityError
      expect(e.code).toBe("invalid-state")
      expect(e.message).toContain("stopped")
    }
  })

  it("checks capability before state, so an unsupported op reports the real reason", () => {
    try {
      assertSandboxOperationAllowed(ctx({ state: "stopped" }), "suspend")
      throw new Error("should have thrown")
    } catch (err) {
      expect((err as SandboxCapabilityError).code).toBe("unsupported-operation")
    }
  })

  it("allows health in every state — it is asked precisely when things are broken", () => {
    const states: SandboxLifecycleState[] = [
      "uninitialized",
      "creating",
      "stopped",
      "starting",
      "running",
      "suspending",
      "suspended",
      "resuming",
      "stopping",
      "deleting",
      "error",
    ]
    for (const state of states) {
      expect(() => assertSandboxOperationAllowed(ctx({ state }), "health")).not.toThrow()
    }
  })

  it.each([
    ["create", "running"],
    ["start", "running"],
    ["stop", "uninitialized"],
    ["gui", "uninitialized"],
    ["workspaceExec", "stopped"],
  ] as const)("refuses %s while %s", (operation, state) => {
    expect(() => assertSandboxOperationAllowed(ctx({ state }), operation)).toThrow(
      SandboxCapabilityError
    )
  })

  it("refuses suspend/resume on a cloud connection in the wrong state", () => {
    const cloud = ctx({
      provider: "cua-cloud",
      capabilities: defaultSandboxCapabilities("cua-cloud", "cua-driver"),
      state: "stopped",
    })
    expect(() => assertSandboxOperationAllowed(cloud, "suspend")).toThrow(/not valid while/)
    expect(() =>
      assertSandboxOperationAllowed({ ...cloud, state: "suspended" }, "resume")
    ).not.toThrow()
  })
})

describe("runSandboxOperation", () => {
  const adapter: SandboxProviderAdapter = {
    provider: "docker",
    driver: "cua-driver",
    stop: jest.fn(async () => {}),
    workspaceExec: jest.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" })),
  }

  it("dispatches a supported operation", async () => {
    await expect(
      runSandboxOperation(adapter, ctx(), "workspaceExec", (a) =>
        a.workspaceExec?.(ctx(), { command: "ls" })
      )
    ).resolves.toEqual({ exitCode: 0, stdout: "ok", stderr: "" })
  })

  it("refuses an unsupported operation without invoking the adapter", async () => {
    const invoke = jest.fn()
    await expect(runSandboxOperation(adapter, ctx(), "suspend", invoke)).rejects.toBeInstanceOf(
      SandboxCapabilityError
    )
    expect(invoke).not.toHaveBeenCalled()
  })

  it("refuses with not-implemented when the adapter lacks an advertised method", async () => {
    // `start` is advertised by the docker matrix but this adapter omits it.
    try {
      await runSandboxOperation(adapter, ctx({ state: "stopped" }), "start", (a) =>
        a.start?.(ctx())
      )
      throw new Error("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxCapabilityError)
      const e = err as SandboxCapabilityError
      expect(e.code).toBe("not-implemented")
      expect(e.operation).toBe("start")
    }
  })

  it("never falls back to a host implementation on refusal", async () => {
    const hostFallback = jest.fn()
    await expect(
      runSandboxOperation(adapter, ctx(), "suspend", () => {
        hostFallback()
        return Promise.resolve("ran on host")
      })
    ).rejects.toBeInstanceOf(SandboxCapabilityError)
    expect(hostFallback).not.toHaveBeenCalled()
  })

  it("propagates an adapter rejection unchanged", async () => {
    const failing: SandboxProviderAdapter = {
      provider: "docker",
      driver: "cua-driver",
      stop: jest.fn(async () => {
        throw new Error("daemon unreachable")
      }),
    }
    await expect(
      runSandboxOperation(failing, ctx(), "stop", (a) => a.stop?.(ctx()))
    ).rejects.toThrow("daemon unreachable")
  })
})

describe("SandboxCapabilityError", () => {
  it("carries a custom message when given one", () => {
    const err = new SandboxCapabilityError({
      code: "missing-credentials",
      operation: "connect",
      provider: "cua-cloud",
      driver: "cua-driver",
      message: "No cua.ai API key in the keyring.",
    })
    expect(err.message).toBe("No cua.ai API key in the keyring.")
    expect(err.code).toBe("missing-credentials")
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("SandboxCapabilityError")
  })

  it("builds a default message naming operation, provider and driver", () => {
    const err = new SandboxCapabilityError({
      code: "not-connected",
      operation: "gui",
      provider: "lume",
      driver: "computer-server",
    })
    expect(err.message).toContain("gui")
    expect(err.message).toContain("lume")
    expect(err.message).toContain("computer-server")
    expect(err.message).toContain("not-connected")
  })
})
