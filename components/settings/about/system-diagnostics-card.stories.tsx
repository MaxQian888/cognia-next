import type { Meta, StoryObj } from "@storybook/nextjs"

import { SystemDiagnosticsCard } from "./system-diagnostics-card"
import {
  makeCrashDiagnostics,
  makeNativeLoggingReadiness,
  makeOsInfo,
} from "@/lib/storybook/fixtures/settings-about"

// Tauri-branching card driven entirely by loader-prop test seams (`osLoader`,
// `dataDirLoader`, `diagnosticsLoader`, `nativeLoggingLoader`). The real loaders
// return null outside Tauri, so we drive the seams here to story both the bare
// web/fallback path and a fully-populated desktop path — no native bridge. The
// "copy diagnostics"/"reveal data dir" buttons fire clipboard/opener calls that
// no-op on the web.
const meta = {
  title: "Settings/About/SystemDiagnosticsCard",
  component: SystemDiagnosticsCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof SystemDiagnosticsCard>

export default meta
type Story = StoryObj<typeof meta>

/** Web/fallback path: every loader resolves null → "unavailable" rows only. */
export const Default: Story = {
  args: {
    osLoader: async () => null,
    dataDirLoader: async () => null,
    diagnosticsLoader: async () => null,
    nativeLoggingLoader: async () => null,
  },
}

/** Desktop path: OS facts, data dir, crash diagnostics, and native logging. */
export const Populated: Story = {
  args: {
    osLoader: async () => makeOsInfo(),
    dataDirLoader: async () => "/Users/dev/Library/Application Support/cognia",
    diagnosticsLoader: async () => makeCrashDiagnostics(),
    nativeLoggingLoader: async () => makeNativeLoggingReadiness(),
  },
}

/** OS facts present, but crash diagnostics unavailable (partial load). */
export const OsOnly: Story = {
  args: {
    osLoader: async () => makeOsInfo({ osType: "Windows", version: "11", arch: "x86_64" }),
    dataDirLoader: async () => null,
    diagnosticsLoader: async () => null,
    nativeLoggingLoader: async () => null,
  },
}
