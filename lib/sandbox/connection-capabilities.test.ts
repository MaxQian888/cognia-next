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

  it("exposes only the implemented Docker/computer-server operations", () => {
    const caps = defaultSandboxCapabilities("docker", "computer-server")
    expect(caps.create).toBe(true)
    expect(caps.start).toBe(true)
    expect(caps.stop).toBe(true)
    expect(caps.delete).toBe(true)
    expect(caps.health).toBe(true)
    expect(caps.gui).toBe(true)
  })

  it("claims suspend and resume only because pause and unpause implement them", () => {
    // `docker pause` SIGSTOPs the container's processes and keeps its memory
    // resident, so the desktop session survives and this is a real suspend.
    // The claim would be false if the adapter used `docker stop`, which is a
    // different machine on the way back.
    const caps = defaultSandboxCapabilities("docker", "computer-server")
    expect(caps.suspend).toBe(true)
    expect(caps.resume).toBe(true)
  })

  it("carries Docker workspace shell and files, because docker exec was proven", () => {
    // Verified against a real container: `docker exec <id> hostname` returns
    // the container id rather than the host's, and its `/etc/os-release`
    // reports the image's distribution. The claim rests on that, not on what
    // the provider could support in principle.
    const caps = defaultSandboxCapabilities("docker", "computer-server")
    expect(caps.workspaceRead).toBe(true)
    expect(caps.workspaceExec).toBe(true)
  })

  it("withholds workspace access from providers with no adapter at all", () => {
    for (const provider of ["cua-cloud", "lume"] as const) {
      const caps = defaultSandboxCapabilities(provider, "computer-server")
      expect(caps.workspaceRead).toBe(false)
      expect(caps.workspaceExec).toBe(false)
    }
  })

  it("keeps cua-cloud and lume rows readable without unsupported actions", () => {
    for (const provider of ["cua-cloud", "lume"] as const) {
      const caps = defaultSandboxCapabilities(provider, "cua-driver")
      expect(Object.values(caps).every((value) => value === false)).toBe(true)
    }
  })

  it("does not advertise health without a registered lifecycle adapter", () => {
    expect(defaultSandboxCapabilities("cua-cloud", "computer-server").health).toBe(false)
    expect(defaultSandboxCapabilities("lume", "cua-driver").health).toBe(false)
  })

  it("withholds Lume workspace access at the provider, not the driver", () => {
    // The computer-server driver carries workspace operations now. What keeps
    // them off a Lume row is that Lume has no adapter at all, so neither
    // driver can reach it.
    for (const driver of DRIVERS) {
      const caps = defaultSandboxCapabilities("lume", driver)
      expect(caps.workspaceRead).toBe(false)
      expect(caps.workspaceExec).toBe(false)
    }
  })

  it("keeps the unregistered cua-driver projection unavailable", () => {
    for (const provider of PROVIDERS) {
      expect(
        Object.values(defaultSandboxCapabilities(provider, "cua-driver")).every(
          (value) => value === false
        )
      ).toBe(true)
    }
  })

  it("returns a frozen object so a caller cannot widen it in place", () => {
    const caps = defaultSandboxCapabilities("docker", "cua-driver")
    expect(Object.isFrozen(caps)).toBe(true)
  })
})

describe("narrowSandboxCapabilities", () => {
  it("removes the listed operations", () => {
    const caps = defaultSandboxCapabilities("docker", "computer-server")
    const narrowed = narrowSandboxCapabilities(caps, ["gui", "suspend"])
    expect(narrowed.gui).toBe(false)
    expect(narrowed.suspend).toBe(false)
    expect(narrowed.start).toBe(true)
  })

  it("never widens", () => {
    const caps = defaultSandboxCapabilities("docker", "computer-server")
    expect(narrowSandboxCapabilities(caps, []).connect).toBe(false)
  })

  it("does not mutate the input", () => {
    const caps = defaultSandboxCapabilities("cua-cloud", "cua-driver")
    narrowSandboxCapabilities(caps, ["gui"])
    expect(caps.gui).toBe(false)
  })

  it("is a no-op for an empty removal list", () => {
    const caps = defaultSandboxCapabilities("docker", "computer-server")
    expect(narrowSandboxCapabilities(caps, [])).toEqual(caps)
  })

  it("never re-enables an already-false capability", () => {
    const caps = defaultSandboxCapabilities("docker", "computer-server")
    expect(narrowSandboxCapabilities(caps, ["connect"]).connect).toBe(false)
  })
})

describe("supportsSandboxOperation", () => {
  it("reads the matrix", () => {
    const caps = defaultSandboxCapabilities("docker", "computer-server")
    expect(supportsSandboxOperation(caps, "start")).toBe(true)
    expect(supportsSandboxOperation(caps, "connect")).toBe(false)
  })
})
