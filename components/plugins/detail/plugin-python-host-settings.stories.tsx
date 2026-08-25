import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginPythonHostSettings } from "./plugin-python-host-settings"

// Python host settings card (python / hybrid plugins) — interpreter path, env
// vars, call timeout, venv toggle, idle shutdown, concurrency, the outbound
// host-RPC gate (ADR-0145), the environment block (installer, scope, custom
// argv templates, guided uv install), and an install-dependencies consent
// block driven by `manifest.pythonDependencies`.
//
// Persisted settings load from Dexie (empty here → defaults). The runtime
// probe and the install actions are Tauri calls that no-op in this browser
// Storybook, so the interpreter/uv strip stays hidden and the environment
// controls render at their defaults.

const meta = {
  title: "Plugins/Detail/PluginPythonHostSettings",
  component: PluginPythonHostSettings,
  args: { pluginId: "com.acme.ocr" },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginPythonHostSettings>

export default meta
type Story = StoryObj<typeof meta>

// Plugin declaring python dependencies → the install-deps consent block shows.
export const WithDependencies: Story = {
  args: { pythonDependencies: ["pillow", "pytesseract", "numpy>=1.26"] },
}

// No declared dependencies → just the host settings fields.
export const NoDependencies: Story = {
  args: { pythonDependencies: [] },
}
