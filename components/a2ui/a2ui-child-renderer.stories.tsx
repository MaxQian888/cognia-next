import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIChildRenderer } from "./a2ui-child-renderer"
import { A2UIRenderer } from "./a2ui-renderer"
import { A2UIProvider } from "./a2ui-context"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { makeSurfaceState } from "@/lib/storybook/fixtures/a2ui"
import { useA2UIStore } from "@/stores/a2ui"

// A2UIChildRenderer expands a list of child component ids via the A2UI context.
// The decorator provides that context from a seeded surface.
const meta = {
  title: "A2UI/ChildRenderer",
  component: A2UIChildRenderer,
  parameters: { layout: "centered" },
  beforeEach: () => {
    resetStore(useA2UIStore)
    seedStore(useA2UIStore, { surfaces: { "story-surface": makeSurfaceState() } })
  },
  decorators: [
    (Story) => (
      <div className="w-[420px] space-y-2">
        <A2UIProvider
          surfaceId="story-surface"
          renderComponent={(component) => <A2UIRenderer key={component.id} component={component} />}
        >
          <Story />
        </A2UIProvider>
      </div>
    ),
  ],
} satisfies Meta<typeof A2UIChildRenderer>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: { childIds: ["heading", "body", "cta"] },
}

export const SingleChild: Story = {
  args: { childIds: ["heading"] },
}
