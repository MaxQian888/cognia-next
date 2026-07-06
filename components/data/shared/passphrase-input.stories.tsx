import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PassphraseInput } from "./passphrase-input"

// Pure controlled input with a show/hide toggle. `withConfirm` adds a second
// field that must match `value` (mismatch surfaces inline).
const meta = {
  title: "Data/PassphraseInput",
  component: PassphraseInput,
  args: { value: "", onChange: fn() },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PassphraseInput>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithConfirm: Story = { args: { withConfirm: true, value: "hunter2" } }

export const Disabled: Story = { args: { value: "locked", disabled: true } }
