import type { Meta, StoryObj } from "@storybook/nextjs"

import { buildDeviceRows } from "@/lib/devices/build-device-rows"
import type { DeviceRow } from "@/lib/devices/types"

import { DeviceListPane } from "./device-list-pane"

const NOW = 1_700_000_000_000

// One realistic fleet, built through the real `buildDeviceRows` rather than
// hand-written rows — a story that fakes the derivation stops catching the
// derivation's mistakes.
const FLEET: DeviceRow[] = buildDeviceRows({
  local: {
    ref: "local",
    label: "Max's MacBook Pro",
    platform: "tauri",
    appVersion: "1.4.2",
    capabilities: ["shell", "pty", "sidecar", "keyring", "browser", "pro-ide"],
    microvmAvailable: false,
    osSandboxAvailable: true,
  },
  pairedDevices: [
    {
      deviceId: "d1",
      label: "Max's iPhone 15",
      platform: "ios",
      pubkey: "k1",
      pairedAt: NOW - 30 * 86_400_000,
      lastSeenAt: NOW - 20_000,
      allowRemoteTerminal: false,
      allowRemoteControl: true,
      appVersion: "1.4.2",
      capabilities: ["camera", "webview", "push-display", "biometric", "barcode-scan"],
      capabilitiesReportedAt: NOW - 20_000,
      serverFingerprint: "a".repeat(56) + "deadbeef",
    },
    {
      // Never reported, and last seen days ago — the two "we do not know"
      // states the matrix has to keep apart.
      deviceId: "d2",
      label: "Old Pixel 6",
      platform: "android",
      pubkey: "k2",
      pairedAt: NOW - 200 * 86_400_000,
      lastSeenAt: NOW - 9 * 86_400_000,
      allowRemoteTerminal: false,
      appVersion: "0.9.1",
    },
    {
      deviceId: "d3",
      label: "Retired iPad",
      platform: "ios",
      pubkey: "k3",
      pairedAt: NOW - 400 * 86_400_000,
      lastSeenAt: NOW - 100 * 86_400_000,
      revokedAt: NOW - 50 * 86_400_000,
      allowRemoteTerminal: false,
      appVersion: "0.8.0",
    },
  ],
  remoteHosts: [
    {
      id: "h1",
      label: "Build box",
      connectionState: "ready",
      addedAt: NOW - 10 * 86_400_000,
      lastConnectedAt: NOW - 5_000,
      config: { baseUrl: "https://build.local:8443", serverVersion: "1.4.2" },
    },
    {
      id: "h2",
      label: "Cloud brain",
      connectionState: "degraded",
      connectionError: "host_capabilities reply had no capability array",
      addedAt: NOW - 3 * 86_400_000,
      lastConnectedAt: NOW - 40 * 60_000,
      config: { baseUrl: "https://cognia.example.com", serverVersion: "1.3.9" },
    },
  ],
  workers: [
    {
      deviceId: "w1",
      hostRef: "worker-ci-1",
      displayName: "CI runner",
      role: "worker",
      status: "active",
      createdAt: NOW - 20 * 86_400_000,
      updatedAt: NOW - 3_000,
      capabilities: ["agent.run"],
    },
  ],
  sandboxConnections: [],
  activeHostId: null,
  now: NOW,
})

const meta = {
  title: "Devices/DeviceListPane",
  component: DeviceListPane,
  parameters: { layout: "fullscreen" },
  args: {
    rows: FLEET,
    selectedRef: "local",
    search: "",
    kindFilter: "all" as const,
    onSearchChange: () => {},
    onKindFilterChange: () => {},
    onSelect: () => {},
  },
  decorators: [
    (Story) => (
      <div className="h-[600px] w-[320px] border-r">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DeviceListPane>

export default meta
type Story = StoryObj<typeof meta>

/** Every kind at once: this machine, two hosts, three phones, one worker. */
export const MixedFleet: Story = {}

/** Nothing paired — the state a fresh install opens on. */
export const Empty: Story = { args: { rows: [] } }

/** A search that matches nothing must not read as "nothing is paired". */
export const NoSearchMatch: Story = { args: { search: "zzz" } }

/** Scoped to one kind, with a host selected. */
export const HostsOnly: Story = {
  args: { kindFilter: "remote-host", selectedRef: "host:h1" },
}
