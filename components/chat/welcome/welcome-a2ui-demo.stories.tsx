import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { WelcomeA2UIDemo } from "./welcome-a2ui-demo"

// Interactive A2UI demo surface for the welcome state. Renders an "Open demo"
// trigger that opens a dialog of quick-action buttons + response settings.
// It self-retires after first view via localStorage, so each story clears it.
const STORAGE_KEY = "a2ui-demo-shown"

const meta = {
  title: "Chat/Welcome/WelcomeA2UIDemo",
  component: WelcomeA2UIDemo,
  parameters: { layout: "centered" },
  args: { onAction: fn(), onSuggestionClick: fn() },
  beforeEach: () => {
    localStorage.removeItem(STORAGE_KEY)
  },
} satisfies Meta<typeof WelcomeA2UIDemo>

export default meta
type Story = StoryObj<typeof meta>

/** The trigger button. Click it to open the A2UI quick-action dialog. */
export const Default: Story = {}

/** Without the response-settings card (quick actions only). */
export const WithoutSettings: Story = {
  args: { showSettings: false },
}
