import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginDetailHeader } from "./plugin-detail-header"
import { makePluginRow } from "@/lib/storybook/fixtures/plugins"

// Detail-pane header: identity (avatar / name / version / description), status
// pill, signature badge, source, the enable/disable toggle, and the primary
// actions (Configure when a config schema exists, Review permissions when
// permissions are declared, Uninstall). The inline diagnostics preview is
// driven by `usePluginDiagnostics` (a live query) — empty here, so it's hidden.
// The `plugin` row is passed directly as a prop, so every variant is fully
// controlled by the story.

const meta = {
  title: "Plugins/Detail/PluginDetailHeader",
  component: PluginDetailHeader,
  args: { plugin: makePluginRow() },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full rounded-lg border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginDetailHeader>

export default meta
type Story = StoryObj<typeof meta>

// Verified, enabled plugin with both Configure and Review-permissions actions.
export const Enabled: Story = {}

// Disabled plugin — the toggle is off and the status pill reflects it.
export const Disabled: Story = {
  args: { plugin: makePluginRow({ enabled: false, status: "disabled" }) },
}

// Loading lifecycle state (enabling) drives the loading pill.
export const Loading: Story = {
  args: { plugin: makePluginRow({ status: "enabling" }) },
}

// Errored plugin from a failed signature check.
export const FailedSignature: Story = {
  args: {
    plugin: makePluginRow({
      status: "error",
      error: "Signature verification failed",
      manifest: {
        ...makePluginRow().manifest,
        signature: { failed: true },
      },
    }),
  },
}

// Minimal manifest: no config schema and no permissions, so the Configure and
// Review-permissions buttons are both hidden — only Uninstall remains.
export const MinimalManifest: Story = {
  args: {
    plugin: makePluginRow({
      id: "com.acme.tiny",
      name: "Tiny Plugin",
      capabilities: [],
      manifest: { id: "com.acme.tiny", name: "Tiny Plugin" },
    }),
  },
}
