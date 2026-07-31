import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"
import { ProviderSidebar } from "./provider-sidebar"

// Pure component: composes a search box, category tabs, status filters and a
// list of `ProviderSidebarItem`s from the `providers` prop. Local state only
// for the status filter; everything else is controlled by the parent.
const PROVIDERS = [
  {
    id: "openai",
    name: "OpenAI",
    subtitle: "gpt-4.1 · o3",
    status: "connected" as const,
    modelCount: 3,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    subtitle: "claude-sonnet-4-6",
    status: "connected" as const,
    modelCount: 2,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    subtitle: "Not configured",
    status: "not-configured" as const,
    modelCount: 0,
  },
  { id: "groq", name: "Groq", subtitle: "Invalid API key", status: "error" as const },
  {
    id: "google",
    name: "Google",
    subtitle: "Rate limited",
    status: "warning" as const,
    modelCount: 5,
  },
]

const meta = {
  title: "Settings/Provider/ProviderSidebar",
  component: ProviderSidebar,
  parameters: { layout: "fullscreen" },
  args: {
    providers: PROVIDERS,
    selectedId: "openai",
    onSelect: fn(),
    onCompareClick: fn(),
    categoryFilter: "all",
    onCategoryChange: fn(),
    searchQuery: "",
    onSearchChange: fn(),
  },
  decorators: [
    (Story) => (
      <div className="h-[600px] w-80 border-r">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProviderSidebar>
export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {}

export const Empty: Story = {
  args: { providers: [], selectedId: null },
}

export const SingleProvider: Story = {
  args: { providers: [PROVIDERS[0]], selectedId: "openai" },
}
