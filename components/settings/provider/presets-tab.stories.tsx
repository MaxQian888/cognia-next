import type { Meta, StoryObj } from "@storybook/nextjs"

import { PresetsTab } from "./presets-tab"

// Pure, props-only tab. Renders four "coming soon" routing-preset cards plus a
// current-config note. Takes an optional provider id / name for the footer.
const meta = {
  title: "Settings/Provider/PresetsTab",
  component: PresetsTab,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PresetsTab>

export default meta
type Story = StoryObj<typeof meta>

// No provider context — footer falls back to "Default".
export const Default: Story = {}

// A named provider is surfaced in the current-config note.
export const WithProviderName: Story = {
  args: { providerId: "openai", providerName: "OpenAI" },
}

// Only an id is known — the note shows the raw id.
export const WithProviderIdOnly: Story = {
  args: { providerId: "anthropic" },
}
