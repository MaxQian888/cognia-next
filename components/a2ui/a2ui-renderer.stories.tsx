import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIRenderer } from "./a2ui-renderer"
import { A2UIProvider } from "./a2ui-context"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { makeSurfaceState } from "@/lib/storybook/fixtures/a2ui"
import { useA2UIStore } from "@/stores/a2ui"

// A2UIRenderer renders a single descriptor and resolves children through the
// A2UI context. The decorator supplies that context (backed by a seeded store)
// the same way A2UISurface does in production.
const meta = {
  title: "A2UI/Renderer",
  component: A2UIRenderer,
  parameters: { layout: "centered" },
  beforeEach: () => {
    resetStore(useA2UIStore)
    seedStore(useA2UIStore, { surfaces: { "story-surface": makeSurfaceState() } })
  },
  decorators: [
    (Story) => (
      <div className="w-[420px]">
        <A2UIProvider
          surfaceId="story-surface"
          renderComponent={(component) => <A2UIRenderer key={component.id} component={component} />}
        >
          <Story />
        </A2UIProvider>
      </div>
    ),
  ],
} satisfies Meta<typeof A2UIRenderer>

export default meta
type Story = StoryObj<typeof meta>

export const Card: Story = {
  args: { component: makeSurfaceState().components.root },
}

export const TextLeaf: Story = {
  args: { component: makeSurfaceState().components.heading },
}

export const ButtonLeaf: Story = {
  args: { component: makeSurfaceState().components.cta },
}
