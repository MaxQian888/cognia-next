import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import {
  AutoComposeAdvancedOptions,
  DEFAULT_AUTO_COMPOSE_OPTIONS,
} from "./auto-compose-advanced-options"

const meta = {
  title: "Agent/Workspace/AutoCompose/AdvancedOptions",
  component: AutoComposeAdvancedOptions,
  args: { options: DEFAULT_AUTO_COMPOSE_OPTIONS, onChange: fn() },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AutoComposeAdvancedOptions>

export default meta
type Story = StoryObj<typeof meta>

// Collapsed advanced panel; expand it to tune roster size / pattern / toggles.
export const Default: Story = {}

export const Disabled: Story = {
  args: { disabled: true },
}
