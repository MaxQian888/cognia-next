import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { LocalPluginDropzone } from "./local-plugin-dropzone"

// Drag-and-drop target for loading an unpacked plugin folder during development.
// The load path is desktop-only; in this browser Storybook the component renders
// its non-Tauri fallback message.

const meta = {
  title: "Plugins/Devtools/LocalPluginDropzone",
  component: LocalPluginDropzone,
  args: { onInstalled: fn() },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[480px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LocalPluginDropzone>

export default meta
type Story = StoryObj<typeof meta>

// Web/browser → the desktop-only fallback.
export const WebFallback: Story = {}
