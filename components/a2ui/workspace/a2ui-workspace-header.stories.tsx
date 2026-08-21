import type { Meta, StoryObj } from "@storybook/nextjs"

import { WorkspaceHeader } from "./a2ui-workspace-header"
import { A2UIToolbar } from "./a2ui-toolbar"
import { A2UIWorkspaceProvider } from "./a2ui-workspace-context"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { makeSurfaceState } from "@/lib/storybook/fixtures/a2ui"
import { useA2UIStore } from "@/stores/a2ui"

// Workspace chrome — a `FeaturePageHeader` that reads the surface title/ready
// state from the store and the active mode from the workspace context. The
// toolbar arrives as `controls`, so the editor has one header instead of two
// stacked bars (see `WithToolbar`).
const meta = {
  title: "A2UI/Workspace/Header",
  component: WorkspaceHeader,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useA2UIStore)
    seedStore(useA2UIStore, { surfaces: { "story-surface": makeSurfaceState() } })
  },
  decorators: [
    (Story) => (
      <A2UIWorkspaceProvider surfaceId="story-surface">
        <Story />
      </A2UIWorkspaceProvider>
    ),
  ],
} satisfies Meta<typeof WorkspaceHeader>

export default meta
type Story = StoryObj<typeof meta>

export const Ready: Story = {}

export const WithToolbar: Story = {
  args: { controls: <A2UIToolbar /> },
}

export const Loading: Story = {
  beforeEach: () => {
    resetStore(useA2UIStore)
    seedStore(useA2UIStore, {
      surfaces: { "story-surface": makeSurfaceState({ ready: false }) },
    })
  },
}
