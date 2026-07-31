import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ReviewHunkItem } from "./review-hunk-item"
import { makeReviewItem } from "@/lib/storybook/fixtures/artifacts"

// One hunk of an AI-revision proposal with accept/reject controls and a
// collapsible inline diff. `status` drives the visual treatment.
const meta = {
  title: "Artifacts/ReviewHunkItem",
  component: ReviewHunkItem,
  args: { item: makeReviewItem(), onAccept: fn(), onReject: fn() },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ReviewHunkItem>

export default meta
type Story = StoryObj<typeof meta>

export const Pending: Story = {}

export const Accepted: Story = {
  args: { item: makeReviewItem({ status: "accepted" }) },
}

export const Rejected: Story = {
  args: { item: makeReviewItem({ status: "rejected" }) },
}

export const Insert: Story = {
  args: {
    item: makeReviewItem({
      changeType: "insert",
      originalText: "",
      proposedText: "    return hits.length < max",
      range: { startLine: 3, endLine: 4 },
      diffLines: [{ type: "added", content: "    return hits.length < max" }],
    }),
  },
}

export const Disabled: Story = {
  args: { disabled: true },
}
