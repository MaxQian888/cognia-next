import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { PluginCliToolsSection } from "./plugin-cli-tools-section"
import type { PluginManifest } from "@/types/plugin"

// CLI Tools section of the Capabilities sub-tab — lists every declarative
// `manifest.cliTools` entry with the wrapped binary's live status pill. The
// live status comes from `getPluginBinaryStatuses`, which probes the host via
// Tauri; in this plain-browser Storybook there is no host, so the probe
// rejects/returns nothing and every `requires` binary renders in its default
// "Not installed" state — that's the branch these stories paint. The tool name,
// description, wrapped-binary name, and install-help deep link are all driven
// purely by the `manifest` prop. The component returns `null` when a manifest
// has no `cliTools`, so there is no empty story to render.

const makeManifest = (cliTools: PluginManifest["cliTools"]): PluginManifest =>
  ({
    id: "com.acme.ripgrep-tools",
    name: "Ripgrep Tools",
    version: "0.1.0",
    description: "Wrap external search/media binaries as agent tools.",
    type: "frontend",
    capabilities: ["cli-tools"],
    requires: {
      binaries: [
        { name: "rg", minVersion: "13.0.0", documentation: "https://example.com/install/ripgrep" },
        { name: "ffmpeg", minVersion: "6.0", documentation: "https://example.com/install/ffmpeg" },
      ],
    },
    cliTools,
  }) as unknown as PluginManifest

const SINGLE_TOOL = makeManifest([
  {
    name: "ripgrep_search",
    description: "Search files in the workspace with ripgrep.",
    parameters: { type: "object", properties: { pattern: { type: "string" } } },
    binary: { kind: "requires", name: "rg" },
    argv: [{ param: "pattern" }],
  },
])

const meta = {
  title: "Plugins/Detail/PluginCliToolsSection",
  component: PluginCliToolsSection,
  args: { manifest: SINGLE_TOOL },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[640px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginCliToolsSection>

export default meta
type Story = StoryObj<typeof meta>

// One `requires`-backed tool. With no host probe the binary shows the
// "Not installed" pill plus the manifest's install-help deep link.
export const SingleTool: Story = {}

// Several wrapped binaries, including a plugin-dir (shipped) binary that has no
// status pill at all — only `requires` tools render the availability badge.
export const MultipleTools: Story = {
  args: {
    manifest: makeManifest([
      {
        name: "ripgrep_search",
        description: "Search files in the workspace with ripgrep.",
        parameters: { type: "object", properties: { pattern: { type: "string" } } },
        binary: { kind: "requires", name: "rg" },
        argv: [{ param: "pattern" }],
      },
      {
        name: "ffmpeg_transcode",
        description: "Transcode a media file to a different container/codec.",
        parameters: { type: "object", properties: { input: { type: "string" } } },
        binary: { kind: "requires", name: "ffmpeg" },
        argv: [{ literal: "-i" }, { param: "input" }],
      },
      {
        name: "bundled_formatter",
        description: "Format a document using a binary shipped inside the plugin.",
        parameters: { type: "object", properties: { file: { type: "string" } } },
        binary: { kind: "plugin-dir", relPath: "bin/formatter" },
        argv: [{ param: "file" }],
      },
    ]),
  },
}
