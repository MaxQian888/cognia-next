import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { InstallWasmPluginButton } from "./install-wasm-plugin-button"

// "Install WASM plugin from local file" trigger button. Clicking opens a file
// picker + capability-grant sheet on the host; in this Storybook the button
// renders in its idle state.

const meta = {
  title: "Plugins/Dialogs/InstallWasmPluginButton",
  component: InstallWasmPluginButton,
  args: { onInstalled: fn() },
  parameters: { layout: "centered" },
} satisfies Meta<typeof InstallWasmPluginButton>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
