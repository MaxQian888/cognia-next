import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"
import { ProviderSidebarItem } from "./provider-sidebar-item"

// Pure component: renders a single selectable provider row in the settings
// sidebar. All state is prop-driven; `onClick` is a callback.
const meta = {
  title: "Settings/Provider/ProviderSidebarItem",
  component: ProviderSidebarItem,
  args: {
    providerId: "openai",
    name: "OpenAI",
    subtitle: "gpt-4.1 · gpt-4.1-mini",
    status: "connected",
    isSelected: false,
    onClick: fn(),
    modelCount: 3,
  },
  decorators: [
    (Story) => (
      <div className="w-72 rounded-lg border p-1">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProviderSidebarItem>
export default meta
type Story = StoryObj<typeof meta>

export const Connected: Story = {}

export const Selected: Story = {
  args: { isSelected: true },
}

export const Warning: Story = {
  args: { status: "warning", subtitle: "Rate limited" },
}

export const NotConfigured: Story = {
  args: { providerId: "deepseek", name: "DeepSeek", status: "not-configured", modelCount: 0 },
}

export const Error: Story = {
  args: { providerId: "groq", name: "Groq", status: "error", subtitle: "Invalid API key" },
}

export const CustomIconNode: Story = {
  args: {
    providerId: "custom-gateway",
    name: "Custom Gateway",
    icon: <span className="text-primary">★</span>,
    subtitle: "https://gateway.example.com/v1",
    status: "connected",
  },
}
