import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ProviderDefaultsEditor } from "./provider-defaults-editor"

// `ProviderDefaultsEditor` is a controlled collapsible — the card supplies the
// persisted `defaultOptions` and persists whatever `onChange` emits. The editor
// itself owns only its open/closed state.
const meta = {
  title: "Settings/Search/Shared/ProviderDefaultsEditor",
  component: ProviderDefaultsEditor,
  parameters: { layout: "padded" },
  args: {
    providerId: "tavily",
    value: undefined,
    onChange: fn(),
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl rounded-lg border p-3">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProviderDefaultsEditor>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {}

export const WithOverrides: Story = {
  args: { value: { searchType: "news", maxResults: 10 } },
}

// Serper supports recency + videos but not AI answers — the field set differs.
export const SerperFeatureSet: Story = {
  args: { providerId: "serper" },
}
