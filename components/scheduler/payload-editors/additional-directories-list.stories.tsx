import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { AdditionalDirectoriesList } from "./additional-directories-list"

// Controlled list of working directories for a chat-style scheduled task. The
// Tauri folder-picker button only renders inside the desktop shell, so in
// Storybook every row shows just the path input + remove control.
const meta = {
  title: "Scheduler/PayloadEditors/AdditionalDirectoriesList",
  component: AdditionalDirectoriesList,
  parameters: { layout: "padded" },
  args: {
    onChange: fn(),
    testId: "additional-directories",
  },
} satisfies Meta<typeof AdditionalDirectoriesList>

export default meta
type Story = StoryObj<typeof meta>

// No directories yet → empty hint + a single "add" button.
export const Empty: Story = {
  args: { value: undefined },
}

// A populated list, one row per path.
export const WithDirectories: Story = {
  args: {
    value: ["/home/user/projects/cognia", "/var/data/reports", "/tmp/scratch"],
  },
}

// Read-only rendering — every input and button is disabled.
export const Disabled: Story = {
  args: {
    value: ["/home/user/projects/cognia", "/var/data/reports"],
    disabled: true,
  },
}
