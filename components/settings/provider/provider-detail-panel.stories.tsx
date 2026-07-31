import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"
import { ProviderDetailPanel } from "./provider-detail-panel"

// Pure component: the right-hand detail pane. Renders an empty prompt when
// `provider` is null; otherwise a header (status badge, enable switch, optional
// delete) plus a tab strip whose contents are injected as `*Tab` slots.
const meta = {
  title: "Settings/Provider/ProviderDetailPanel",
  component: ProviderDetailPanel,
  parameters: { layout: "fullscreen" },
  args: {
    provider: { id: "openai", name: "OpenAI", modelCount: 12 },
    isEnabled: true,
    connectionStatus: "connected",
    onTest: fn(),
    onToggleEnabled: fn(),
    onDelete: fn(),
    configTab: <p className="text-sm text-muted-foreground">API key, base URL, default model…</p>,
    modelsTab: <p className="text-sm text-muted-foreground">Enabled model list…</p>,
    costTab: <p className="text-sm text-muted-foreground">Usage & spend…</p>,
    advancedTab: <p className="text-sm text-muted-foreground">Headers, timeouts…</p>,
  },
  decorators: [
    (Story) => (
      <div className="flex h-[600px] w-full max-w-3xl flex-col border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProviderDetailPanel>
export default meta
type Story = StoryObj<typeof meta>

export const Connected: Story = {}

export const NoSelection: Story = {
  args: { provider: null },
}

export const ErrorStatus: Story = {
  args: { connectionStatus: "error", isEnabled: true },
}

export const Disabled: Story = {
  args: { isEnabled: false, connectionStatus: "not-configured" },
}

export const CustomWithDelete: Story = {
  args: {
    provider: { id: "custom-gw", name: "Custom Gateway", icon: "★", modelCount: 4 },
    isCustom: true,
    connectionStatus: "connected",
  },
}
