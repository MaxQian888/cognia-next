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

/**
 * The dormancy contract for the two providers that are declared and not
 * implemented (CLAUDE.md rule 7, axis three).
 *
 * `cua-cloud` and `lume` are in the `SandboxConnectionProvider` union, have
 * config shapes, and are formatted by `sandboxConnectionSummary`. What they do
 * not have is an adapter, and ADR-0020 records both as deferred. Pinning it
 * here means adding one to `ADAPTERS` is a deliberate act with a test to
 * update, and removing the UI label that says so fails a test rather than
 * quietly presenting a machine that can never start.
 */
describe("providers that are declared but not implemented", () => {
  function connectionFor(provider: "cua-cloud" | "lume"): SandboxConnectionRow {
    const config =
      provider === "cua-cloud"
        ? { provider: "cua-cloud" as const, instanceName: "inst-1" }
        : { provider: "lume" as const, vmName: "vm-1" }
    return {
      id: `conn-${provider}`,
      name: provider,
      provider,
      driver: "cua-driver",
      config,
      state: "stopped",
      capabilities: defaultSandboxCapabilities(provider, "cua-driver"),
      lastHealthStatus: "unknown",
      createdAt: 0,
      updatedAt: 0,
    } as SandboxConnectionRow
  }

  it.each(["cua-cloud", "lume"] as const)("has no adapter for %s", (provider) => {
    const row = connectionFor(provider)
    expect(sandboxAdapterFactoryFor(row)).toBeNull()
    expect(hasSandboxAdapter(row)).toBe(false)
  })

  it("lists docker as the only implemented pair", () => {
    expect(adapterPairs()).toEqual(["docker:computer-server"])
  })
})
