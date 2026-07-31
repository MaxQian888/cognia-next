import type { Meta, StoryObj } from "@storybook/nextjs"

import { InteractivePageDialog } from "./interactive-page-dialog"
import { Button } from "@/components/ui/button"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useA2UIStore } from "@/stores/a2ui"
import type { ExecutionPageSource } from "@/lib/a2ui/from-execution"

// Builds a shareable A2UI page from an execution source. The baseline page is
// built lazily when the dialog opens, so the default story shows the trigger.
const conversationSource: ExecutionPageSource = {
  kind: "conversation",
  session: {
    id: "session-1",
    title: "Trip planning chat",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  messages: [],
}

const meta = {
  title: "A2UI/InteractivePageDialog",
  component: InteractivePageDialog,
  parameters: { layout: "centered" },
  args: {
    source: conversationSource,
    trigger: <Button>Create interactive page</Button>,
  },
  beforeEach: () => {
    resetStore(useA2UIStore)
  },
} satisfies Meta<typeof InteractivePageDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
