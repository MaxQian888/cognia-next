import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { A2UISearchResultsAdapter } from "./a2ui-search-results-adapter"
import { makeA2UIProps, makePaper } from "@/lib/storybook/fixtures/a2ui"
import type { A2UIComponent } from "@/types/a2ui/schema"

const component: A2UIComponent = { id: "search", component: "AcademicSearchResults" }

// The adapter reads the paper list + query state from the A2UI data model and
// renders AcademicSearchResults.
const meta = {
  title: "A2UI/Academic/SearchResultsAdapter",
  component: A2UISearchResultsAdapter,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-[560px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof A2UISearchResultsAdapter>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: makeA2UIProps(component, {
    dataModel: {
      query: "graph neural networks",
      totalResults: 532,
      papers: [
        makePaper({ id: "p1", title: "Semi-Supervised Classification with Graph Convolutions" }),
        makePaper({ id: "p2", title: "Graph Attention Networks", year: 2018 }),
      ],
      hasMore: true,
    },
    onAction: fn(),
    onDataChange: fn(),
  }),
}

export const Empty: Story = {
  args: makeA2UIProps(component, {
    dataModel: { query: "no results query", totalResults: 0, papers: [] },
    onAction: fn(),
    onDataChange: fn(),
  }),
}
