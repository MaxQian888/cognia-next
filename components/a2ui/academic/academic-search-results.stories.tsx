import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { AcademicSearchResults } from "./academic-search-results"
import { makePaper } from "@/lib/storybook/fixtures/a2ui"

const papers = [
  makePaper(),
  makePaper({
    id: "paper-2",
    title: "Deep Residual Learning for Image Recognition",
    authors: [{ name: "Kaiming He" }],
    year: 2016,
    venue: "CVPR",
    citationCount: 98000,
  }),
  makePaper({
    id: "paper-3",
    title: "BERT: Pre-training of Deep Bidirectional Transformers",
    authors: [{ name: "Jacob Devlin" }],
    year: 2019,
    venue: "NAACL",
    citationCount: 64000,
    isOpenAccess: false,
  }),
]

const meta = {
  title: "A2UI/Academic/SearchResults",
  component: AcademicSearchResults,
  parameters: { layout: "fullscreen" },
  args: {
    papers,
    query: "transformer architecture",
    totalResults: 1287,
    providerResults: {
      arxiv: { count: 412, success: true },
      "semantic-scholar": { count: 875, success: true },
    },
    hasMore: true,
    onPaperSelect: fn(),
    onAddToLibrary: fn(),
    onAnalyzePaper: fn(),
    onLoadMore: fn(),
    onFilterChange: fn(),
  },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-[560px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AcademicSearchResults>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Loading: Story = { args: { papers: [], isLoading: true } }

export const Empty: Story = { args: { papers: [], totalResults: 0, hasMore: false } }
