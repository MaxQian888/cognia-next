import type { SandboxConnectionDriver, SandboxConnectionProvider } from "@/types/sandbox"
import {
  SANDBOX_LIFECYCLE_OPERATIONS,
  defaultSandboxCapabilities,
  narrowSandboxCapabilities,
  supportsSandboxOperation,
} from "./connection-capabilities"

const PROVIDERS: SandboxConnectionProvider[] = ["docker", "cua-cloud", "lume"]
const DRIVERS: SandboxConnectionDriver[] = ["computer-server", "cua-driver"]

describe("defaultSandboxCapabilities", () => {
  it("returns an entry for every operation, for every pair", () => {
    for (const provider of PROVIDERS) {
      for (const driver of DRIVERS) {
        const caps = defaultSandboxCapabilities(provider, driver)
        for (const op of SANDBOX_LIFECYCLE_OPERATIONS) {
          expect(typeof caps[op]).toBe("boolean")
        }
      }
    }
  })

  it("gives docker no suspend/resume — a stopped container is not a paused machine", () => {
    const caps = defaultSandboxCapabilities("docker", "cua-driver")
    expect(caps.suspend).toBe(false)
    expect(caps.resume).toBe(false)
    expect(caps.start).toBe(true)
    expect(caps.stop).toBe(true)
    expect(caps.delete).toBe(true)
  })

  it("gives cua-cloud and lume the full lifecycle including suspend/resume", () => {
    for (const provider of ["cua-cloud", "lume"] as const) {
      const caps = defaultSandboxCapabilities(provider, "cua-driver")
      expect(caps.suspend).toBe(true)
      expect(caps.resume).toBe(true)
      expect(caps.create).toBe(true)
      expect(caps.delete).toBe(true)
    }
  })

  it("always allows health, so a broken machine can still be probed", () => {
    for (const provider of PROVIDERS) {
      for (const driver of DRIVERS) {
        expect(defaultSandboxCapabilities(provider, driver).health).toBe(true)
      }
    }
  })

  it("lets the computer-server driver remove workspaceRead", () => {
    expect(defaultSandboxCapabilities("lume", "computer-server").workspaceRead).toBe(false)
    expect(defaultSandboxCapabilities("lume", "cua-driver").workspaceRead).toBe(true)
  })

  it("keeps computer-server workspace shell and files disabled until a real adapter exists", () => {
    const caps = defaultSandboxCapabilities("lume", "computer-server")
    expect(caps.workspaceRead).toBe(false)
    expect(caps.workspaceExec).toBe(false)
  })

  it("a driver can only remove capabilities, never add them", () => {
    for (const provider of PROVIDERS) {
      const permissive = defaultSandboxCapabilities(provider, "cua-driver")
      const restricted = defaultSandboxCapabilities(provider, "computer-server")
      for (const op of SANDBOX_LIFECYCLE_OPERATIONS) {
        if (restricted[op]) expect(permissive[op]).toBe(true)
      }
    }
  })

  it("returns a frozen object so a caller cannot widen it in place", () => {
    const caps = defaultSandboxCapabilities("docker", "cua-driver")
    expect(Object.isFrozen(caps)).toBe(true)
  })
})

describe("narrowSandboxCapabilities", () => {
  it("removes the listed operations", () => {
    const caps = defaultSandboxCapabilities("cua-cloud", "cua-driver")
    const narrowed = narrowSandboxCapabilities(caps, ["gui", "suspend"])
    expect(narrowed.gui).toBe(false)
    expect(narrowed.suspend).toBe(false)
    expect(narrowed.start).toBe(true)
  })

  it("does not mutate the input", () => {
    const caps = defaultSandboxCapabilities("cua-cloud", "cua-driver")
    narrowSandboxCapabilities(caps, ["gui"])
    expect(caps.gui).toBe(true)
  })

  it("is a no-op for an empty removal list", () => {
    const caps = defaultSandboxCapabilities("docker", "cua-driver")
    expect(narrowSandboxCapabilities(caps, [])).toEqual(caps)
  })

  it("never re-enables an already-false capability", () => {
    const caps = defaultSandboxCapabilities("docker", "cua-driver")
    expect(narrowSandboxCapabilities(caps, ["suspend"]).suspend).toBe(false)
  })
})

describe("supportsSandboxOperation", () => {
  it("reads the matrix", () => {
    const caps = defaultSandboxCapabilities("docker", "cua-driver")
    expect(supportsSandboxOperation(caps, "start")).toBe(true)
    expect(supportsSandboxOperation(caps, "suspend")).toBe(false)
  })
})
