import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ArtifactDesignerWrapper } from "./panel-designer-wrapper"
import { makeTypedArtifact } from "@/lib/storybook/fixtures/artifacts"

// Stub "Preview in Designer" dialog — cognia-next has no visual designer yet, so
// it renders an unsupported notice for html / react / svg artifacts.
const meta = {
  title: "Artifacts/ArtifactDesignerWrapper",
  component: ArtifactDesignerWrapper,
  args: {
    artifact: makeTypedArtifact("html", "landing.html", "<h1>Hi</h1>"),
    open: true,
    onOpenChange: fn(),
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ArtifactDesignerWrapper>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

export const Closed: Story = {
  args: { open: false },
}
