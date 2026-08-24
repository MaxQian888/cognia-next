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
    workers: [],
    sandboxConnections: [],
    activeHostId: null,
    now: NOW,
    ...overrides,
  })
}

function phone(reported: boolean): Parameters<typeof buildDeviceRows>[0]["pairedDevices"][number] {
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
  }
}

const meta = {
  title: "Devices/DeviceDetail",
  component: DeviceDetail,
  parameters: { layout: "fullscreen" },
  args: { activeTab: "overview" as const, onTabChange: () => {}, actions: noopActions },
  decorators: [
    (Story) => (
      <div className="h-[720px] w-full max-w-[760px] border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DeviceDetail>

export default meta
type Story = StoryObj<typeof meta>

/** Nothing chosen — the pane still says what it is for. */
export const NoSelection: Story = { args: { row: null } }

export const ThisMachine: Story = { args: { row: fleet()[0]! } }

/** The capability matrix of a device that has answered. */
export const PhoneCapabilities: Story = {
  args: {
    row: fleet({ pairedDevices: [phone(true)] }).find((row) => row.kind === "paired-device")!,
    activeTab: "capabilities",
  },
}

/**
 * The state the console exists to keep honest: nothing is `absent`, the
 * baseline entries read `Expected`, and one banner explains the rest.
 */
export const NeverReportedCapabilities: Story = {
  args: {
    row: fleet({ pairedDevices: [phone(false)] }).find((row) => row.kind === "paired-device")!,
    activeTab: "capabilities",
  },
}

/** Grants expanded into the capabilities they confer. */
export const PhoneAccess: Story = {
  args: {
    row: fleet({ pairedDevices: [phone(true)] }).find((row) => row.kind === "paired-device")!,
    activeTab: "access",
  },
}

/** Shell tiers, the sandbox registry, workspaces and the timing authority. */
export const LocalRuntime: Story = { args: { row: fleet()[0]!, activeTab: "runtime" } }

/** A phone hosts neither sandboxes nor workspaces — and says why. */
export const PhoneRuntime: Story = {
  args: {
    row: fleet({ pairedDevices: [phone(true)] }).find((row) => row.kind === "paired-device")!,
    activeTab: "runtime",
  },
}
