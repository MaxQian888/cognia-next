import { HostUpdateUnsupportedError, type HostUpdateStatus } from "@/lib/remote-host/host-update"

import { createHostAdapter, hostCandidate, type HostAdapterDeps } from "./host-adapter"

const status = (overrides: Partial<HostUpdateStatus> = {}): HostUpdateStatus => ({
  install: "native",
  currentVersion: "1.4.0",
  channel: "beta",
  autoUpdate: true,
  phase: "available",
  available: { version: "1.5.0", criticality: "critical", releaseNotes: "Notes" },
  installRequested: false,
  ...overrides,
})

const context = { channel: "stable" as const, rolloutBucket: 0, manual: true, catalog: null }

function deps(overrides: Partial<HostAdapterDeps> = {}): HostAdapterDeps {
  return {
    listHosts: () => [
      { id: "mini", label: "Mac mini" },
      { id: "nas", label: "NAS" },
      { id: "old", label: "Old host" },
    ],
    readStatus: async (id) => {
      if (id === "old") throw new HostUpdateUnsupportedError()
      if (id === "nas") return status({ phase: "idle", available: undefined })
      return status()
    },
    install: async () => status({ installRequested: true }),
    ...overrides,
  }
}

describe("host adapter", () => {
  it("offers one row per host with a release, named for the host", async () => {
    const candidates = await createHostAdapter(deps()).check(context)
    expect(candidates).toEqual([
      expect.objectContaining({
        assetId: "mini",
        kind: "host-server",
        executor: "cognia-host",
        displayName: "Mac mini",
        currentVersion: "1.4.0",
        targetVersion: "1.5.0",
        channel: "beta",
        criticality: "critical",
        provenance: "verified",
      }),
    ])
  })

  it("leaves out a host that cannot install updates itself", () => {
    expect(
      hostCandidate({ id: "h", label: "h" }, status({ install: "unmanaged" }), "stable")
    ).toBeNull()
    expect(
      hostCandidate(
        { id: "h", label: "h" },
        status({ channel: "x" as never, available: { version: "2", criticality: "odd" } }),
        "stable"
      )
    ).toMatchObject({ channel: "stable", criticality: "routine" })
  })

  it("exists only while an always-on host is paired", () => {
    expect(createHostAdapter(deps({ listHosts: () => [] })).isSupported()).toBe(false)
    expect(createHostAdapter(deps()).isSupported()).toBe(true)
  })

  it("asks the host to update and waits for it to report back", async () => {
    const install = jest.fn(async () => status({ installRequested: true }))
    const adapter = createHostAdapter(deps({ install }))
    const [candidate] = await adapter.check(context)
    await expect(adapter.apply(candidate, { consented: true })).resolves.toEqual({
      state: "awaiting-host",
    })
    expect(install).toHaveBeenCalledWith("mini")
  })

  it("names why an update could not be asked for", async () => {
    const [candidate] = await createHostAdapter(deps()).check(context)
    const old = createHostAdapter(
      deps({
        install: async () => {
          throw new HostUpdateUnsupportedError()
        },
      })
    )
    await expect(old.apply(candidate, { consented: true })).resolves.toMatchObject({
      state: "failed",
      failure: { kind: "unsupported", code: "host_update_unsupported" },
    })
    const busy = createHostAdapter(
      deps({
        install: async () => {
          throw new Error("an update operation is already running")
        },
      })
    )
    await expect(busy.apply(candidate, { consented: true })).resolves.toMatchObject({
      state: "failed",
      failure: { code: "host_update_refused" },
    })
  })
})
