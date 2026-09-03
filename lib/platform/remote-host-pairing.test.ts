/** @jest-environment jsdom */
/** Hosts paired through the registry behind Settings > Remote hosts (ADR-0082). */
import {
  hasPairedRemoteHost,
  notifyRemoteHostPairingChanged,
  REMOTE_HOST_PAIRING_EVENT,
  REMOTE_HOST_STORE_KEY,
  subscribeRemoteHostPairing,
} from "./remote-host-pairing"

/** Shape the store persists: `partialize` strips the private JWKs, nothing else. */
function writeRemoteHostStore(
  rows: Array<{ baseUrl?: string; deviceId?: string; deviceKeyThumbprint?: string }>
): void {
  window.localStorage.setItem(
    REMOTE_HOST_STORE_KEY,
    JSON.stringify({
      version: 3,
      state: {
        hosts: rows.map((row, index) => ({
          id: `host-${index}`,
          label: "Brain",
          credentialRef: `remote-host:host-${index}:device-private-jwk`,
          addedAt: 1,
          connectionState: "disconnected",
          config: {
            baseUrl: row.baseUrl ?? "https://brain.example:27890",
            deviceId: row.deviceId ?? "device-1",
            deviceKeyThumbprint: row.deviceKeyThumbprint ?? "thumb-1",
            serverVersion: "1.0.0",
            devicePrivateKeyJwk: undefined,
          },
        })),
      },
    })
  )
}

afterEach(() => {
  window.localStorage.clear()
})

describe("hasPairedRemoteHost", () => {
  it("false with no row, malformed json, or no host list", () => {
    expect(hasPairedRemoteHost()).toBe(false)
    window.localStorage.setItem(REMOTE_HOST_STORE_KEY, "{oops")
    expect(hasPairedRemoteHost()).toBe(false)
    window.localStorage.setItem(REMOTE_HOST_STORE_KEY, JSON.stringify({ version: 3, state: {} }))
    expect(hasPairedRemoteHost()).toBe(false)
    window.localStorage.setItem(
      REMOTE_HOST_STORE_KEY,
      JSON.stringify({ version: 3, state: { hosts: [] } })
    )
    expect(hasPairedRemoteHost()).toBe(false)
  })

  it("ignores a row with no registered device identity", () => {
    writeRemoteHostStore([{ deviceKeyThumbprint: "" }])
    expect(hasPairedRemoteHost()).toBe(false)
    writeRemoteHostStore([{ deviceId: "" }])
    expect(hasPairedRemoteHost()).toBe(false)
    writeRemoteHostStore([{ baseUrl: "" }])
    expect(hasPairedRemoteHost()).toBe(false)
  })

  it("detects a host paired through Settings > Remote hosts", () => {
    writeRemoteHostStore([{}])
    expect(hasPairedRemoteHost()).toBe(true)
  })

  it("answers on the pairing, not on whether a host is currently driving the app", () => {
    // `activeHostId` is never persisted, so this is exactly the state a paired
    // browser reloads into: a host on file and nothing connected.
    writeRemoteHostStore([{}])
    expect(hasPairedRemoteHost()).toBe(true)
  })

  it("notifies subscribers and stops on unsubscribe", () => {
    const seen: number[] = []
    const stop = subscribeRemoteHostPairing(() => seen.push(1))
    // A raw listener too: the exported name is what other listeners bind to,
    // so notify and subscribe agreeing with each other is not enough.
    const raw: number[] = []
    const onRaw = () => raw.push(1)
    window.addEventListener(REMOTE_HOST_PAIRING_EVENT, onRaw)
    notifyRemoteHostPairingChanged()
    notifyRemoteHostPairingChanged()
    expect(seen).toHaveLength(2)
    expect(raw).toHaveLength(2)
    window.removeEventListener(REMOTE_HOST_PAIRING_EVENT, onRaw)
    stop()
    notifyRemoteHostPairingChanged()
    expect(seen).toHaveLength(2)
  })

  it("is announced by every remote-host registry write that adds or drops a host", async () => {
    // The profile is derived from the persisted list and localStorage has no
    // same-tab change event, so a write that forgets to announce leaves every
    // mounted surface on the pre-pairing answer until the next reload.
    const fs = await import("node:fs")
    const path = await import("node:path")
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "stores", "remote-host", "remote-host-store.ts"),
      "utf8"
    )
    expect(source.match(/notifyRemoteHostPairingChanged\(\)/g)).toHaveLength(3)
  })

  it("matches the key the remote-host store persists under", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "stores", "remote-host", "remote-host-store.ts"),
      "utf8"
    )
    expect(source).toContain(`name: "${REMOTE_HOST_STORE_KEY}"`)
  })
})
