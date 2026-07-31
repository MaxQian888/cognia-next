import type { Meta, StoryObj } from "@storybook/nextjs"
import type { UIMessage } from "ai"

import { CompactBoundaryMarker, type CompactBoundaryPartData } from "./compact-boundary-part"

const message = (part: CompactBoundaryPartData): UIMessage =>
  ({
    id: "compact-1",
    role: "system",
    parts: [part],
  }) as unknown as UIMessage

const meta = {
  title: "Chat/MessageParts/CompactBoundaryMarker",
  component: CompactBoundaryMarker,
  parameters: { layout: "padded" },
} satisfies Meta<typeof CompactBoundaryMarker>

export default meta
type Story = StoryObj<typeof meta>

// Token-detailed boundary — shows the from→to compaction figures.
export const WithTokenDelta: Story = {
  args: {
    message: message({
      type: "compact-boundary",
      trigger: "auto",
      preTokens: 184_000,
      postTokens: 42_000,
    }),
  },
}

// Manual /compact with no token figures — generic "manual" detail.
export const Manual: Story = {
  args: { message: message({ type: "compact-boundary", trigger: "manual" }) },
}
