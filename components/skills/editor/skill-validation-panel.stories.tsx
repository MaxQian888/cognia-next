import type { Meta, StoryObj } from "@storybook/nextjs"

import { SkillValidationPanel } from "./skill-validation-panel"

// Pure props-only — validates the draft on render and renders the findings.
const meta = {
  title: "Skills/Editor/SkillValidationPanel",
  component: SkillValidationPanel,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="h-72 max-w-md border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SkillValidationPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Valid: Story = {
  args: {
    draft: {
      name: "release-notes",
      description: "Drafts release notes.",
      content: "# Release Notes\n\nBody.",
    },
    resources: [],
  },
}

export const Invalid: Story = {
  args: {
    draft: { name: "", description: "x".repeat(2000), content: "" },
    resources: [],
  },
}
