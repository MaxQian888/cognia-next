import type { Meta, StoryObj } from "@storybook/nextjs"

import { PerfSystemTab } from "./perf-system-tab"
import type { SystemDetails } from "@/lib/perf/backend/types"

const details: SystemDetails = {
  os: "macOS",
  osVersion: "15.5",
  kernelVersion: "24.5.0",
  arch: "aarch64",
  family: "unix",
  hostname: "workstation",
  cpu: "Apple M3 Max",
  cpuCount: 14,
  totalMemoryBytes: 68_719_476_736,
  usedMemoryBytes: 34_359_738_368,
  appVersion: "0.1.0",
  tauriVersion: "2.9.0",
  profile: "release",
  enabledFeatures: ["ocr", "vector", "tts"],
}

// Static host + build facts from `perf_system_details`. `load` is injected here
// because the underlying Tauri command resolves `null` on web.
const meta = {
  title: "Performance/PerfSystemTab",
  component: PerfSystemTab,
  args: { load: async (): Promise<SystemDetails | null> => details },
  parameters: { layout: "padded" },
} satisfies Meta<typeof PerfSystemTab>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {}

// Fields the host declined to report collapse to an em-dash placeholder.
export const PartialHostInfo: Story = {
  args: {
    load: async () => ({
      ...details,
      osVersion: null,
      kernelVersion: null,
      hostname: null,
      cpu: null,
      enabledFeatures: [],
    }),
  },
}

// No native runtime (web/mobile) — the command resolves null, not an error.
export const Unavailable: Story = {
  args: { load: async () => null },
}
