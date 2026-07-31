import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { WasmCapabilityGrantSheet } from "./wasm-capability-grant-sheet"
import type { PluginManifest } from "@/types/plugin"

// Capability-grant sheet shown before a WASM plugin install completes. Groups
// the manifest's declared permissions by domain (filesystem / network /
// clipboard / os-process / secrets / …), flags dangerous groups, and lets the
// user grant/deny before the install writes. Fully prop-driven.

const manifest = (permissions: string[], over: Partial<PluginManifest> = {}): PluginManifest =>
  ({
    id: "com.acme.wasm-tool",
    name: "WASM Tool",
    version: "0.3.0",
    type: "wasm",
    description: "A sandboxed WebAssembly plugin.",
    permissions,
    ...over,
  }) as unknown as PluginManifest

const meta = {
  title: "Plugins/Dialogs/WasmCapabilityGrantSheet",
  component: WasmCapabilityGrantSheet,
  args: {
    open: true,
    manifest: manifest(["filesystem:read", "network:fetch", "clipboard:read"]),
    authorFingerprint: "ed25519:9f:3a:c1:7e",
    onOpenChange: fn(),
    onConfirm: fn(),
    onCancel: fn(),
  },
  parameters: { layout: "centered" },
} satisfies Meta<typeof WasmCapabilityGrantSheet>

export default meta
type Story = StoryObj<typeof meta>

// Signed plugin requesting a handful of low-risk capabilities.
export const Signed: Story = {}

// Unsigned local-file install (empty fingerprint) requesting dangerous
// os-process + filesystem-write capabilities → dangerous groups are flagged.
export const UnsignedDangerous: Story = {
  args: {
    authorFingerprint: "",
    manifest: manifest([
      "filesystem:read",
      "filesystem:write",
      "shell:execute",
      "process:spawn",
      "secrets:read",
    ]),
  },
}
