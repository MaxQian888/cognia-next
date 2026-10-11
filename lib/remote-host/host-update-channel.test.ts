import { hostChannelFor, pushChannelToHosts, type PushedChannelStore } from "./host-update-channel"

function memoryStore(initial: Record<string, "stable" | "beta"> = {}): PushedChannelStore & {
  value: Record<string, "stable" | "beta">
} {
  const store = {
    value: { ...initial },
    read: () => ({ ...store.value }),
    write: (value: Record<string, "stable" | "beta">) => {
      store.value = { ...value }
    },
  }
  return store
}

describe("hostChannelFor", () => {
  it("gives a host stable or beta, never the internal canary", () => {
    expect(hostChannelFor("stable")).toBe("stable")
    expect(hostChannelFor("beta")).toBe("beta")
    expect(hostChannelFor("canary")).toBe("beta")
  })
})

describe("pushChannelToHosts", () => {
  it("pushes to a host it has not pushed to, then leaves it alone", async () => {
    const configure = jest.fn(async () => undefined)
    const store = memoryStore()
    await expect(pushChannelToHosts("beta", ["mini"], { configure, store })).resolves.toEqual([
      "mini",
    ])
    expect(configure).toHaveBeenCalledWith("mini", { channel: "beta" })
    // A later launch on the same channel does not undo a host-panel choice.
    await pushChannelToHosts("beta", ["mini"], { configure, store })
    expect(configure).toHaveBeenCalledTimes(1)
  })

  it("pushes again when this device's channel changes", async () => {
    const configure = jest.fn(async (_id: string, _patch: { channel: string }) => undefined)
    const store = memoryStore({ mini: "stable", nas: "stable" })
    await pushChannelToHosts("beta", ["mini", "nas"], { configure, store })
    expect(configure.mock.calls.map(([id]) => id).sort()).toEqual(["mini", "nas"])
    expect(store.value).toEqual({ mini: "beta", nas: "beta" })
  })

  it("retries a host that did not take it, and forgets unpaired hosts", async () => {
    const configure = jest.fn(async (id: string) => {
      if (id === "offline") throw new Error("unreachable")
    })
    const store = memoryStore({ gone: "beta" })
    await expect(
      pushChannelToHosts("stable", ["mini", "offline"], { configure, store })
    ).resolves.toEqual(["mini"])
    expect(store.value).toEqual({ mini: "stable" })
    await pushChannelToHosts("stable", ["mini", "offline"], { configure, store })
    expect(configure.mock.calls.filter(([id]) => id === "offline")).toHaveLength(2)
  })
})
