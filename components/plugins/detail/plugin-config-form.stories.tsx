import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PluginConfigFormBody } from "./plugin-config-form"
import { makePluginRow } from "@/lib/storybook/fixtures/plugins"

// Schema-driven plugin settings form. `PluginConfigFormBody` takes the plugin
// row directly (the `Content` wrapper just resolves it from Dexie first), parses
// `manifest.configSchema` into typed fields, seeds defaults, validates, and
// persists via `setPluginConfig`. These stories pass rich schemas to exercise
// the string / number / boolean / enum field renderers.

const withSchema = (configSchema: Record<string, unknown>) =>
  makePluginRow({
    manifest: { ...makePluginRow().manifest, configSchema },
  })

const meta = {
  title: "Plugins/Detail/PluginConfigForm",
  component: PluginConfigFormBody,
  args: { pluginId: "com.acme.web-tools", onClose: fn() },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full rounded-lg border p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginConfigFormBody>

export default meta
type Story = StoryObj<typeof meta>

// A mix of field types: text, number, boolean, and an enum select.
export const MixedFields: Story = {
  args: {
    plugin: withSchema({
      type: "object",
      properties: {
        apiBase: {
          type: "string",
          title: "API base URL",
          description: "Where requests are sent.",
          default: "https://api.example.com",
        },
        maxResults: { type: "number", title: "Max results", default: 10 },
        verbose: { type: "boolean", title: "Verbose logging", default: false },
        mode: {
          type: "string",
          title: "Mode",
          enum: ["fast", "balanced", "thorough"],
          default: "balanced",
        },
      },
    }),
  },
}

// Empty schema → the "no configurable settings" path.
export const NoSchema: Story = {
  args: {
    plugin: makePluginRow({ manifest: { id: "com.acme.web-tools", name: "Web Tools" } }),
  },
}
