let settingsState: unknown = { settings: null }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => settingsState },
}))

let remoteHostState: unknown = { hosts: [] }
jest.mock("@/stores/remote-host/remote-host-store", () => ({
  useRemoteHostStore: { getState: () => remoteHostState },
}))

import {
  createDevicesProvider,
  loadDeviceSearchRows,
  DEFAULT_DEVICES_PROVIDER_DEPS,
  type DevicesProviderDeps,
} from "./devices"
import type { GlobalSearchContext } from "../types"
import type { PairedDeviceRow } from "@/types/mobile/paired-device"
import type { RemoteHostInput, SshHostInput } from "@/lib/devices/types"

function phone(overrides: Partial<PairedDeviceRow> = {}): PairedDeviceRow {
  return {
    deviceId: "d1",
    label: "Max's iPhone",
    platform: "ios",
    pubkey: "k",
    pairedAt: 1,
    lastSeenAt: 1_000,
    allowRemoteTerminal: false,
    appVersion: "1.0.0",
    ...overrides,
  }
}

function host(overrides: Partial<RemoteHostInput> = {}): RemoteHostInput {
  return {
    id: "h1",
    label: "Build box",
    connectionState: "ready",
    addedAt: 5,
    lastConnectedAt: 2_000,
    config: { baseUrl: "https://build.local", serverVersion: "2.0.0" },
    ...overrides,
  }
}

function sshHost(overrides: Partial<SshHostInput> = {}): SshHostInput {
  return {
    id: "s1",
    name: "prod-web-01",
    host: "10.0.4.21",
    port: 22,
    username: "deploy",
    authMethod: "privateKey",
    ...overrides,
  }
}

function deps(overrides: Partial<DevicesProviderDeps> = {}): DevicesProviderDeps {
  return {
    listPairedDevices: (async () => [phone()]) as DevicesProviderDeps["listPairedDevices"],
    listRemoteHosts: () => [host()],
    listSshHosts: () => [sshHost()],
    ...overrides,
  }
}

const ctx = {
  now: 10_000,
  t: (key: string) => key,
} as unknown as GlobalSearchContext

describe("loadDeviceSearchRows", () => {
  it("indexes every kind of remote machine under one kind", async () => {
    const rows = await loadDeviceSearchRows(deps())
    expect(rows).toEqual([
      {
        ref: "device:d1",
        kind: "paired-device",
        label: "Max's iPhone",
        detail: "ios",
        timestamp: 1_000,
      },
      {
        ref: "host:h1",
        kind: "remote-host",
        label: "Build box",
        detail: "https://build.local",
        timestamp: 2_000,
      },
      // No timestamp: nothing records when an SSH profile was last reached,
      // and inventing one would sort it against machines that do know.
      {
        ref: "ssh:s1",
        kind: "ssh-host",
        label: "prod-web-01",
        detail: "deploy@10.0.4.21:22",
      },
    ])
  })

  /**
   * A search provider runs on every keystroke. A Dexie failure must degrade to
   * "no devices matched", never take the palette down with it.
   */
  it("survives a Dexie read failure", async () => {
    const rows = await loadDeviceSearchRows(
      deps({
        listPairedDevices: (async () => {
          throw new Error("db closed")
        }) as DevicesProviderDeps["listPairedDevices"],
      })
    )
    expect(rows.map((row) => row.ref)).toEqual(["host:h1", "ssh:s1"])
  })
})

describe("devicesProvider", () => {
  it("matches on the label and links into the console", async () => {
    const provider = createDevicesProvider(deps())
    const result = await provider.search({
      query: { needle: "iphone", raw: "iphone" } as never,
      ctx,
      limit: 10,
      signal: new AbortController().signal,
    })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      id: "device:device:d1",
      kind: "device",
      title: "Max's iPhone",
      action: { type: "navigate", href: "/devices?device=device%3Ad1" },
    })
  })

  /**
   * A ref pasted from a log has to resolve to the device it names; hunting for
   * it by eye through the list is the thing this avoids.
   */
  it("matches on the ref, not just the label", async () => {
    const provider = createDevicesProvider(deps())
    const result = await provider.search({
      query: { needle: "host:h1", raw: "host:h1" } as never,
      ctx,
      limit: 10,
      signal: new AbortController().signal,
    })
    expect(result.items.map((item) => item.title)).toContain("Build box")
  })

  it("returns nothing rather than everything for an unmatched needle", async () => {
    const provider = createDevicesProvider(deps())
    const result = await provider.search({
      query: { needle: "zzzzz", raw: "zzzzz" } as never,
      ctx,
      limit: 10,
      signal: new AbortController().signal,
    })
    expect(result.items).toEqual([])
  })
})

/**
 * Every case above injects `deps`, so the wiring the app actually runs is only
 * covered here. A wrong read in the defaults returns `[]` forever and leaves
 * the whole suite green, which is exactly how the SSH list shipped broken: it
 * named `settings.terminalSettings`, a key `AppSettings` has never declared.
 * The settings path now lives in `lib/terminal/saved-ssh-hosts` with its own
 * cases; both other defaults are asserted here.
 */
describe("DEFAULT_DEVICES_PROVIDER_DEPS", () => {
  it("reads remote hosts off the store the app really keeps them in", () => {
    remoteHostState = { hosts: [host()] }
    expect(DEFAULT_DEVICES_PROVIDER_DEPS.listRemoteHosts()).toEqual([host()])
  })

  it("reads saved SSH hosts off the settings the app really writes", () => {
    settingsState = { settings: { terminal: { sshHosts: [sshHost()] } } }
    expect(DEFAULT_DEVICES_PROVIDER_DEPS.listSshHosts()).toEqual([sshHost()])
  })

  it("is empty before either store loads, rather than throwing", () => {
    settingsState = { settings: null }
    remoteHostState = { hosts: [] }
    expect(DEFAULT_DEVICES_PROVIDER_DEPS.listSshHosts()).toEqual([])
    expect(DEFAULT_DEVICES_PROVIDER_DEPS.listRemoteHosts()).toEqual([])
  })
})

/**
 * The provider's `load` is cached, so a rejection does not just cost this
 * keystroke: devices stay missing from the palette until the TTL expires. Every
 * source therefore fails alone.
 */
describe("loadDeviceSearchRows source isolation", () => {
  const boom = () => {
    throw new Error("store not hydrated")
  }

  it("keeps the other two sources when the paired-device read rejects", async () => {
    const rows = await loadDeviceSearchRows(
      deps({
        listPairedDevices: (async () => {
          throw new Error("dexie closed")
        }) as DevicesProviderDeps["listPairedDevices"],
      })
    )
    expect(rows.map((row) => row.kind)).toEqual(["remote-host", "ssh-host"])
  })

  it("keeps the other two sources when the remote-host store throws", async () => {
    const rows = await loadDeviceSearchRows(deps({ listRemoteHosts: boom }))
    expect(rows.map((row) => row.kind)).toEqual(["paired-device", "ssh-host"])
  })

  it("keeps the other two sources when the SSH read throws", async () => {
    const rows = await loadDeviceSearchRows(deps({ listSshHosts: boom }))
    expect(rows.map((row) => row.kind)).toEqual(["paired-device", "remote-host"])
  })
})
