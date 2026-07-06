import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginPythonHostSettings } from "./plugin-python-host-settings"

// Python host settings card (python / hybrid plugins) — interpreter path, env
// vars, call timeout, venv toggle, idle shutdown, concurrency, and an
// install-dependencies consent block driven by `manifest.pythonDependencies`.
// Persisted settings load from Dexie (empty here → defaults); the actual
// install action is a Tauri call that no-ops in this browser Storybook.

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
