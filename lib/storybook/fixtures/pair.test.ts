import { makeDiscoveredServer, makePairedDevice } from "./pair"

describe("pair story fixtures", () => {
  it("builds internally consistent discovered-server defaults and preserves overrides", () => {
    const server = makeDiscoveredServer({ ip: "10.0.0.8", port: 9443, latencyMs: 7 })

    expect(server).toMatchObject({
      id: "10.0.0.8:9443",
      baseUrl: "https://10.0.0.8:9443",
      latencyMs: 7,
    })
  })

  it("denies remote terminal access by default and preserves an explicit grant", () => {
    expect(makePairedDevice().allowRemoteTerminal).toBe(false)
    expect(makePairedDevice({ allowRemoteTerminal: true }).allowRemoteTerminal).toBe(true)
  })
})
