import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { ArtifactPreview } from "./artifact-preview"
import type { Artifact, ArtifactType } from "@/types"

const STAMP = new Date(1_700_000_000_000)

const artifact = (type: ArtifactType, title: string, content: string): Artifact => ({
  id: `art_${type}`,
  sessionId: "ses_1",
  messageId: "msg_1",
  type,
  title,
  content,
  version: 1,
  createdAt: STAMP,
  updatedAt: STAMP,
})

const meta = {
  title: "Artifacts/ArtifactPreview",
  component: ArtifactPreview,
  parameters: { layout: "padded" },
} satisfies Meta<typeof ArtifactPreview>

export default meta
type Story = StoryObj<typeof meta>

// `document` is the markdown adapter (renderer transport); `code` and `mermaid`
// are also renderer-transport, so they render inline without an iframe runtime.
export const Document: Story = {
  args: {
    artifact: artifact(
      "document",
      "Design notes",
      "# Design notes\n\n- First point\n- Second point\n\n**Bold** and `inline code`."
    ),
  },
}

export const Code: Story = {
  args: {
    artifact: artifact("code", "greet.ts", "export const greet = (n: string) => `Hello, ${n}!`\n"),
  },
}

export const Mermaid: Story = {
  args: {
    artifact: artifact("mermaid", "Flow", "graph TD\n  A[Start] --> B[Done]"),
  },
}
