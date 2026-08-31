import type { SandboxConnectionRow } from "@/types/sandbox"
import { adapterPairs, hasSandboxAdapter, sandboxAdapterFactoryFor } from "./adapter-registry"
import { defaultSandboxCapabilities } from "./connection-capabilities"

function row(overrides: Partial<SandboxConnectionRow> = {}): SandboxConnectionRow {
  return {
    id: "conn-1",
    name: "desktop",
    provider: "docker",
    driver: "computer-server",
    config: { provider: "docker", image: "image", host: "127.0.0.1", port: 0 },
    state: "uninitialized",
    capabilities: defaultSandboxCapabilities("docker", "computer-server"),
    lastHealthStatus: "unknown",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe("sandboxAdapterFactoryFor", () => {
  it("resolves the Docker/computer-server adapter", () => {
    expect(sandboxAdapterFactoryFor(row())).toBeInstanceOf(Function)
    expect(hasSandboxAdapter(row())).toBe(true)
  })

  it("has no adapter for a provider nothing here can drive", () => {
    // Provider documentation is not an implementation. A cloud row must stay
    // adapterless until something in this repository can actually drive it.
    for (const provider of ["cua-cloud", "lume"] as const) {
      const other = row({
        provider,
        config:
          provider === "cua-cloud"
            ? { provider: "cua-cloud", instanceName: "desk" }
            : { provider: "lume", vmName: "vm" },
      })
      expect(sandboxAdapterFactoryFor(other)).toBeNull()
      expect(hasSandboxAdapter(other)).toBe(false)
    }
  })

  it("has no adapter for the cua-driver transport", () => {
    expect(sandboxAdapterFactoryFor(row({ driver: "cua-driver" }))).toBeNull()
  })

  it("refuses a row whose provider and config disagree", () => {
    // Such a row carries no image, so starting it would ask Docker to run
    // nothing at all. Catching it here keeps the UI from offering actions that
    // would refuse the instant they were pressed.
    const mismatched = row({ config: { provider: "lume", vmName: "compat" } })
    expect(sandboxAdapterFactoryFor(mismatched)).toBeNull()
    expect(hasSandboxAdapter(mismatched)).toBe(false)
  })

  it("lists exactly the pairs that are implemented", () => {
    // A pair appearing here without a working adapter would let the UI enable
    // controls that cannot run, which is the failure mode the capability
    // contract exists to prevent.
    expect(adapterPairs()).toEqual(["docker:computer-server"])
  })
})
