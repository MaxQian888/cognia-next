import type { Meta, StoryObj } from "@storybook/nextjs"

import { ModelManager } from "./model-manager"

// Placeholder surface: native model-download support (gguf catalog, progress)
// is deferred in cognia-next, so the component renders a single informational
// Alert. Pure — no props, store, or async.

const meta = {
  title: "Settings/Provider/ModelManager",
  component: ModelManager,
  parameters: { layout: "padded" },
} satisfies Meta<typeof ModelManager>

export default meta
type Story = StoryObj<typeof meta>

// The "native model downloads deferred" notice.
export const Default: Story = {}
