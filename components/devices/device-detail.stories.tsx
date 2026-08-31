import type { Meta, StoryObj } from "@storybook/nextjs"

import { buildDeviceRows } from "@/lib/devices/build-device-rows"
import type { DeviceRow } from "@/lib/devices/types"
import type { DeviceGrantActions } from "@/hooks/devices/use-device-grant-actions"

import { DeviceDetail } from "./device-detail"

/**
 * Stories read against the wall clock, not a frozen instant.
 *
 * A pinned epoch makes every row say "3 years ago" and gets worse each year,
 * which defeats the point of a story you look at to judge how the surface
 * reads. Purity does not apply here: a story is not a render pass and not a
 * test — no suite imports this file.
 */
const NOW = Date.now()

const noopActions: DeviceGrantActions = {
  toggleRemoteControl: async () => {},
  toggleAgentControl: async () => {},
  toggleRemoteTerminal: async () => {},
  toggleLockedComputerUse: async () => {},
  pause: async () => {},
  resume: async () => {},
  revoke: async () => {},
}

function fleet(overrides: Partial<Parameters<typeof buildDeviceRows>[0]> = {}): DeviceRow[] {
  return buildDeviceRows({
    local: {
      ref: "local",
      label: "Max's MacBook Pro",
      platform: "tauri",
      appVersion: "1.4.2",
      capabilities: ["shell", "pty", "sidecar", "keyring", "browser"],
      microvmAvailable: false,
      osSandboxAvailable: true,
    },
    pairedDevices: [],
    remoteHosts: [],
    sshHosts: [],
    workers: [],
    sandboxConnections: [],
    activeHostId: null,
    holdsWanConnections: true,
    now: NOW,
    ...overrides,
  })
}

function phone(
  reported: boolean,
  overrides: Partial<Parameters<typeof buildDeviceRows>[0]["pairedDevices"][number]> = {}
): Parameters<typeof buildDeviceRows>[0]["pairedDevices"][number] {
  return {
    deviceId: "d1",
    label: "Max's iPhone 15",
    platform: "ios",
    pubkey: "k1",
    pairedAt: NOW - 30 * 86_400_000,
    lastSeenAt: NOW - 20_000,
    allowRemoteTerminal: false,
    allowRemoteControl: true,
    appVersion: "1.4.2",
    serverFingerprint: "a".repeat(56) + "deadbeef",
    ...(reported
      ? {
          capabilities: ["camera", "webview", "push-display", "biometric"],
          capabilitiesReportedAt: NOW - 20_000,
        }
      : {}),
    ...overrides,
  }
}

function host(
  overrides: Partial<Parameters<typeof buildDeviceRows>[0]["remoteHosts"][number]> = {}
): Parameters<typeof buildDeviceRows>[0]["remoteHosts"][number] {
  return {
    id: "h1",
    label: "Build box",
    connectionState: "ready",
    addedAt: NOW - 90 * 86_400_000,
    lastConnectedAt: NOW - 45_000,
    capabilities: ["shell", "pty", "keyring"],
    capabilitiesAt: NOW - 45_000,
    featureManifest: {
      version: 1,
      features: {
        "workflow.execution": { version: 1, operations: ["run", "cancel"] },
        "terminal.session": { version: 2, operations: ["open", "resize", "close"] },
      },
    },
    featureManifestAt: NOW - 45_000,
    config: {
      baseUrl: "https://build.local:8443",
      serverVersion: "1.4.0",
      serverFingerprint: "b".repeat(56) + "c0ffee00",
    },
    ...overrides,
  }
}

function pick(rows: DeviceRow[], kind: DeviceRow["kind"]): DeviceRow {
  const found = rows.find((candidate) => candidate.kind === kind)
  if (!found) throw new Error(`no ${kind} row in fixture`)
  return found
}

const meta = {
  title: "Devices/DeviceDetail",
  component: DeviceDetail,
  parameters: { layout: "fullscreen" },
  args: { actions: noopActions },
  decorators: [
    (Story) => (
      <div className="h-[860px] w-full max-w-[1040px] border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DeviceDetail>

export default meta
type Story = StoryObj<typeof meta>

/** Nothing chosen — the pane still says what it is for. */
export const NoSelection: Story = { args: { row: null } }

/**
 * This machine: shell tiers, the sandbox registry, workspaces and routing.
 * The densest dashboard the console renders.
 */
export const LocalMachine: Story = { args: { row: fleet()[0]! } }

/** A phone that has answered — the matrix separates reported from absent. */
export const PhoneReported: Story = {
  args: { row: pick(fleet({ pairedDevices: [phone(true)] }), "paired-device") },
}

/**
 * The state the console exists to keep honest: nothing reads "Not available",
 * the baseline entries read "Expected", and one banner explains the rest.
 * The stat strip flags it in amber rather than showing a healthy-looking 0.
 */
export const PhoneNeverReported: Story = {
  args: { row: pick(fleet({ pairedDevices: [phone(false)] }), "paired-device") },
}

/**
 * Revoked, so every grant is off and the lifecycle card offers only pairing
 * again. The masthead badge is the first thing that says so.
 */
export const PhoneRevoked: Story = {
  args: {
    row: pick(
      fleet({ pairedDevices: [phone(true, { revokedAt: NOW - 3_600_000 })] }),
      "paired-device"
    ),
  },
}

/**
 * A connected Host: feature manifest grouped by execution vs proxy, plus the
 * connect / rename / remove controls absorbed from Settings.
 */
export const RemoteHost: Story = {
  args: { row: pick(fleet({ remoteHosts: [host()], activeHostId: "h1" }), "remote-host") },
}

/** A Host that failed its last handshake — the error is stated, not swallowed. */
export const RemoteHostFailed: Story = {
  args: {
    row: pick(
      fleet({
        remoteHosts: [
          host({
            connectionState: "degraded",
            connectionError: "host_capabilities reply had no array",
          }),
        ],
      }),
      "remote-host"
    ),
  },
}
