import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { EncryptionOptions } from "./encryption-options"

// Pure props — a radio group of the three backup encryption modes; the nested
// passphrase field renders only for the "passphrase" mode.
const meta = {
  title: "Data/EncryptionOptions",
  component: EncryptionOptions,
  args: {
    mode: "plaintext",
    onModeChange: fn(),
    passphrase: "",
    onPassphraseChange: fn(),
  },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof EncryptionOptions>

export default meta
type Story = StoryObj<typeof meta>

export const Plaintext: Story = {}

export const AutoKey: Story = { args: { mode: "auto-key" } }

export const Passphrase: Story = { args: { mode: "passphrase", passphrase: "hunter2" } }
