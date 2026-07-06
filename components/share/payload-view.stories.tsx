import type { Meta, StoryObj } from "@storybook/nextjs"

import { PayloadView } from "./payload-view"
import type { SharePayload } from "@/lib/share/types"

const text: SharePayload = {
  kind: "chat-text",
  mime: "text/plain",
  encoding: "utf8",
  title: "Shared conversation",
  data: "User: How do I rate-limit a function?\n\nAssistant: Use a sliding window of timestamps…",
}

// Single rendering unit for the public share viewer + owner preview. Renders by
// `payload.kind`; HTML kinds render in a sandboxed iframe.
const meta = {
  title: "Share/PayloadView",
  component: PayloadView,
  args: { payload: text },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="min-h-[400px] w-full bg-background p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PayloadView>

export default meta
type Story = StoryObj<typeof meta>

export const PlainText: Story = {}

export const Markdown: Story = {
  args: {
    payload: {
      kind: "chat-md",
      mime: "text/markdown",
      encoding: "utf8",
      title: "Design notes",
      data: "# Design notes\n\n- First point\n- Second point",
    },
  },
}

export const Html: Story = {
  args: {
    payload: {
      kind: "chat-html",
      mime: "text/html",
      encoding: "utf8",
      title: "Rendered conversation",
      data: "<h1>Hello</h1><p>Rendered inside a sandboxed iframe.</p>",
    },
  },
}

export const DiscoverItem: Story = {
  args: {
    payload: {
      kind: "discover-item",
      mime: "application/json",
      encoding: "utf8",
      title: "Reviewer skill",
      data: JSON.stringify({
        kind: "skill",
        name: "Code Reviewer",
        description: "Reviews diffs for correctness and style.",
        content: "When asked, review the diff and list findings by severity.",
        tags: ["review", "quality"],
      }),
    },
  },
}
