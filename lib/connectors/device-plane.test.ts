/**
 * The device-plane list is a hand-kept constant, so its only defence against
 * drifting from the manifest the host actually enforces is this file.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  DEVICE_PLANE_CONNECTOR_COMMANDS,
  connectorCommandsNeedTransport,
  connectorDeviceLease,
  isDevicePlaneConnectorCommand,
  setConnectorDeviceLease,
} from "./device-plane"

interface ManifestCommand {
  name: string
  target?: string
  transports?: string[]
}

const manifest = JSON.parse(
  readFileSync(join(process.cwd(), "protocol/companion-commands.json"), "utf8")
) as { commands: ManifestCommand[] }

const connectorCommands = manifest.commands.filter((c) => c.name.startsWith("connectors_"))

afterEach(() => setConnectorDeviceLease(null))

/**
 * `connectors_*` commands a device can reach that this module deliberately
 * does NOT route.
 *
 * The runtime singleton lease is held by whichever process actually runs
 * adapters. The headless brain contends for it through its own in-process
 * invoker (`lib/headless/runtimes/connector-runtime.ts`), and a shell that
 * runs no runtime has nothing to contend for — so routing these from a
 * settings form would be a shell claiming ownership of a runtime it does not
 * host.
 */
const DELIBERATELY_EXCLUDED = [
  "connectors_runtime_lease_acquire",
  "connectors_runtime_lease_renew",
  "connectors_runtime_lease_release",
]

describe("DEVICE_PLANE_CONNECTOR_COMMANDS", () => {
  it("matches the host-admin arms ADR-0152 raised", () => {
    const hostAdmin = connectorCommands
      .filter((c) => c.target === "host-admin" && (c.transports ?? []).includes("http"))
      .map((c) => c.name)
      .sort()

    expect([...DEVICE_PLANE_CONNECTOR_COMMANDS].sort()).toEqual(hostAdmin)
  })

  it("accounts for every connectors_* command a device could otherwise reach", () => {
    // The drift guard proper: a manifest change that opens a new connector
    // command to devices fails here, forcing a decision about whether the
    // wrappers should route it rather than letting it rot as a 403.
    const deviceReachable = connectorCommands
      .filter((c) => c.target !== "service" && (c.transports ?? []).includes("http"))
      .map((c) => c.name)
      .sort()

    expect(deviceReachable).toEqual(
      [...DEVICE_PLANE_CONNECTOR_COMMANDS, ...DELIBERATELY_EXCLUDED].sort()
    )
  })

  it("lists nothing the manifest still keeps service-only", () => {
    // The other direction of the same guard: a name added here without the
    // manifest change would route over a transport that 403s before the RPC
    // layer sees it, replacing a clear explanation with a protocol error.
    const serviceOnly = new Set(
      connectorCommands.filter((c) => c.target === "service").map((c) => c.name)
    )
    for (const name of DEVICE_PLANE_CONNECTOR_COMMANDS) {
      expect(serviceOnly.has(name)).toBe(false)
    }
  })

  it("covers the four keyring arms ADR-0152 raised", () => {
    expect([...DEVICE_PLANE_CONNECTOR_COMMANDS].sort()).toEqual([
      "connectors_keyring_delete",
      "connectors_keyring_get",
      "connectors_keyring_list",
      "connectors_keyring_set",
    ])
  })

  it("leaves the runtime-process commands off the plane", () => {
    for (const name of [
      "connectors_health",
      "connectors_http_request",
      "connectors_start_server",
    ]) {
      expect(isDevicePlaneConnectorCommand(name)).toBe(false)
    }
  })
})

describe("connectorCommandsNeedTransport", () => {
  it("routes only the profiles whose keyring lives on a paired host", () => {
    expect(connectorCommandsNeedTransport("cloud-companion")).toBe(true)
    expect(connectorCommandsNeedTransport("mobile-companion")).toBe(true)
  })

  it("leaves a host that owns its own keyring on local IPC", () => {
    expect(connectorCommandsNeedTransport("desktop")).toBe(false)
    // A brain granting itself a lease to read its own keyring is a loop; it
    // replaces the whole invoker instead.
    expect(connectorCommandsNeedTransport("headless")).toBe(false)
    // Nowhere to route to: a doomed round trip would only look like a real
    // attempt.
    expect(connectorCommandsNeedTransport("web-standalone")).toBe(false)
  })
})

describe("setConnectorDeviceLease", () => {
  it("round-trips the token and clears on null", () => {
    expect(connectorDeviceLease()).toBeNull()
    setConnectorDeviceLease("lease-abc")
    expect(connectorDeviceLease()).toBe("lease-abc")
    setConnectorDeviceLease(null)
    expect(connectorDeviceLease()).toBeNull()
  })
})
