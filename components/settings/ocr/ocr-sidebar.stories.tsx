import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { OcrSidebar, OCR_AUTO_ROUTER_ID } from "./ocr-sidebar"
import { SAMPLE_SIDEBAR_PROVIDERS } from "@/lib/storybook/fixtures/settings-ocr"

// Pure presentational sidebar — search, category tabs, pinned Compare +
// Auto-Router rows, the grouped/flat provider list, the Clear-cache footer and
// the stats row. All state is controlled by the parent, so stories vary props.
const meta = {
  title: "Settings/Ocr/OcrSidebar",
  component: OcrSidebar,
  args: {
    providers: SAMPLE_SIDEBAR_PROVIDERS,
    autoRouterSubtitle: "auto → Mistral OCR",
    selectedId: OCR_AUTO_ROUTER_ID,
    searchQuery: "",
    categoryFilter: "all",
    stats: { enabled: 6, local: 3, cloud: 4 },
    onSelect: fn(),
    onSearchChange: fn(),
    onCategoryChange: fn(),
    onClearCache: fn(),
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-[360px] border-r">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof OcrSidebar>

export default meta
type Story = StoryObj<typeof meta>

/** Default "All" view — providers grouped by category with headers. */
export const AllGrouped: Story = {}

/** A single-category filter renders a flat, ungrouped list. */
export const LocalCategory: Story = {
  args: {
    categoryFilter: "local",
    providers: SAMPLE_SIDEBAR_PROVIDERS.filter((p) => p.category === "local"),
  },
}

export const ProviderSelected: Story = {
  args: { selectedId: "mistral-ocr" },
}

export const WithSearchQuery: Story = {
  args: { searchQuery: "vision" },
}

export const Empty: Story = {
  args: { providers: [], stats: { enabled: 0, local: 0, cloud: 0 } },
}
