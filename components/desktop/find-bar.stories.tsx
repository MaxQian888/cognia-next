import type { Meta, StoryObj } from "@storybook/nextjs"

import { FindBar } from "./find-bar"
import { resetStores } from "@/lib/storybook/seed-stores"
import { useUIStore } from "@/stores/ui/ui-store"

// In-app find bar. Opens on Ctrl/Cmd+F; here we force it open and provide some
// searchable copy so typing highlights matches (where the browser supports the
// CSS Custom Highlight API).
const meta = {
  title: "Desktop/FindBar",
  component: FindBar,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStores(useUIStore)
    useUIStore.setState({ findOpen: true })
  },
  decorators: [
    (Story) => (
      <div data-find-scope className="min-h-64 p-8 text-sm leading-7">
        <p>
          The quick brown fox jumps over the lazy dog. Type in the find bar to highlight matches —
          try &ldquo;the&rdquo; or &ldquo;fox&rdquo;.
        </p>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FindBar>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}
