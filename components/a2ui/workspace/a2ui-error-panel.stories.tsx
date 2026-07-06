import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIErrorPanel } from "./a2ui-error-panel"
import { A2UIWorkspaceProvider } from "./a2ui-workspace-context"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { makeSurfaceState } from "@/lib/storybook/fixtures/a2ui"
import { useA2UIStore } from "@/stores/a2ui"

// Collapsible error panel — renders only when the active surface has an error.
const meta = {
  title: "A2UI/Workspace/ErrorPanel",
  component: A2UIErrorPanel,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useA2UIStore)
    seedStore(useA2UIStore, {
      surfaces: { "story-surface": makeSurfaceState() },
      errors: { "story-surface": "Failed to resolve binding /user/name on component cta." },
    })
  },
  decorators: [
    (Story) => (
      <A2UIWorkspaceProvider surfaceId="story-surface">
        <Story />
      </A2UIWorkspaceProvider>
    ),
  ],
} satisfies Meta<typeof A2UIErrorPanel>

export default meta
type Story = StoryObj<typeof meta>

export const WithError: Story = {}
