import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PluginMarketplaceSourcesDialogView } from "./sources-dialog-view"
import {
  sampleMarketplaceSources,
  sampleRecommendedSources,
  sampleSourcePreview,
} from "@/lib/storybook/fixtures/plugins"

// The redesigned "add a marketplace source" dialog, end to end. Pure props —
// no Dexie, no GitHub API — so every step of the paste → preview → confirm
// flow is a story rather than something you can only reach by having a real
// repository around.

const meta = {
  title: "Plugins/Marketplace/SourcesDialogView",
  component: PluginMarketplaceSourcesDialogView,
  args: {
    open: true,
    onOpenChange: fn(),
    input: "",
    onInputChange: fn(),
    resolvedRef: null,
    previewState: { kind: "idle" },
    onPreview: fn(),
    onDismissPreview: fn(),
    onConfirmAdd: fn(),
    adding: false,
    sources: [],
    onRefreshAll: fn(),
    refreshingAll: false,
    onRefreshSource: fn(),
    onRemoveSource: fn(),
    onOpenRepo: fn(),
    recommended: [],
    busyRecommendedRef: null,
    onAddRecommended: fn(),
  },
  parameters: { layout: "centered" },
} satisfies Meta<typeof PluginMarketplaceSourcesDialogView>

export default meta
type Story = StoryObj<typeof meta>

// First run: no sources, curated marketplaces offered as a one-click start.
export const EmptyWithRecommendations: Story = {
  args: { recommended: sampleRecommendedSources() },
}

// No sources and no curated list configured — the plain empty sentence, which
// is what ships until real recommended repositories exist.
export const EmptyWithoutRecommendations: Story = {}

// A pasted github.com URL, echoed back as the canonical ref it resolves to
// before a single API request is spent.
export const ResolvingPastedUrl: Story = {
  args: {
    input: "https://github.com/acme/plugins/tree/main/packages",
    resolvedRef: "acme/plugins@main",
    recommended: sampleRecommendedSources(),
  },
}

// Catalog fetch in flight.
export const PreviewLoading: Story = {
  args: {
    input: "acme/plugins",
    resolvedRef: "acme/plugins",
    previewState: { kind: "loading" },
  },
}

// The core of the redesign: the catalog is shown before anything is saved.
export const PreviewReady: Story = {
  args: {
    input: "acme/plugins",
    resolvedRef: "acme/plugins",
    previewState: { kind: "ready", preview: sampleSourcePreview() },
  },
}

// A catalog that parses but lists nothing yet — still addable.
export const PreviewEmptyCatalog: Story = {
  args: {
    input: "solo/first-marketplace",
    previewState: {
      kind: "ready",
      preview: sampleSourcePreview({
        id: "solo/first-marketplace",
        name: "solo/first-marketplace",
        owner: undefined,
        entries: [],
      }),
    },
  },
}

// Re-adding something already saved: the CTA is inert rather than silently
// overwriting the row.
export const PreviewAlreadyAdded: Story = {
  args: {
    input: "acme/plugins",
    previewState: {
      kind: "ready",
      preview: sampleSourcePreview({ alreadyAdded: true }),
    },
    sources: sampleMarketplaceSources(),
  },
}

// The repo has no catalog at any of the three candidate paths.
export const PreviewError: Story = {
  args: {
    input: "acme/not-a-marketplace",
    resolvedRef: "acme/not-a-marketplace",
    previewState: {
      kind: "error",
      message: "Could not read this repository: no marketplace.json found in this repository",
    },
  },
}

// Confirm pressed — the add is in flight.
export const Adding: Story = {
  args: {
    input: "acme/plugins",
    previewState: { kind: "ready", preview: sampleSourcePreview() },
    adding: true,
  },
}

// Saved sources covering every sync state: healthy, syncing, failed, never.
export const WithSources: Story = {
  args: { sources: sampleMarketplaceSources() },
}

// "Refresh all" in flight.
export const RefreshingAll: Story = {
  args: { sources: sampleMarketplaceSources(), refreshingAll: true },
}

// Curated sources stay reachable after the first one is added — swapping the
// block out with the saved list would strand the rest behind manual typing.
export const CuratedAlongsideSaved: Story = {
  args: {
    sources: sampleMarketplaceSources().slice(0, 1),
    recommended: sampleRecommendedSources(),
  },
}
