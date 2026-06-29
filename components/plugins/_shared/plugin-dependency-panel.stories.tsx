import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginDependencyPanel } from "./plugin-dependency-panel"
import type { PluginManifest } from "@/types/plugin"

// Unified dependency view reused by the marketplace detail sheet, installed
// overview, and GitHub install preview. Three sections render conditionally:
// plugin dependencies (installed check via a Dexie live query — empty in this
// Storybook, so everything shows "missing"), required system binaries (probed
// via Tauri `detectCli`, which has no host here, so each shows the "checking"
// then "not found" branch), and python dependencies. The panel returns `null`
// when the manifest declares no dependencies of any kind.

const manifest = (over: Partial<PluginManifest>): PluginManifest => over as PluginManifest

const meta = {
  title: "Plugins/Shared/PluginDependencyPanel",
  component: PluginDependencyPanel,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[420px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginDependencyPanel>

export default meta
type Story = StoryObj<typeof meta>

// Required + optional plugin dependencies. With an empty Dexie store none are
// installed, so each row shows the amber "missing" marker.
export const PluginDependencies: Story = {
  args: {
    manifest: manifest({
      dependencies: { "com.cognia.core": "^1.0.0", "com.acme.shared-ui": "~2.3.0" },
      optionalDependencies: { "com.acme.telemetry": "^0.5.0" },
    }),
  },
}

// Required binaries with min-version badges. No host probe in Storybook, so
// each binary settles on the destructive "not found" state.
export const RequiredBinaries: Story = {
  args: {
    manifest: manifest({
      requires: {
        binaries: [
          { name: "rg", minVersion: "13.0.0" },
          { name: "ffmpeg", minVersion: "6.0" },
          { name: "git" },
        ],
      },
    }),
  },
}

// Python dependencies render as a flat badge cloud.
export const PythonDependencies: Story = {
  args: {
    manifest: manifest({
      pythonDependencies: ["pillow", "pytesseract", "numpy>=1.26"],
    }),
  },
}

// All three sections at once — the densest realistic manifest.
export const AllSections: Story = {
  args: {
    manifest: manifest({
      dependencies: { "com.cognia.core": "^1.0.0" },
      optionalDependencies: { "com.acme.telemetry": "^0.5.0" },
      requires: { binaries: [{ name: "tesseract", minVersion: "5.0" }] },
      pythonDependencies: ["pillow", "pytesseract"],
    }),
  },
}
