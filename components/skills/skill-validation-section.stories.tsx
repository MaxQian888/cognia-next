import type { Meta, StoryObj } from "@storybook/nextjs"

import { SkillValidationSection } from "./skill-validation-section"
import { makeValidationError } from "@/lib/storybook/fixtures/skills"

// Pure props-only — renders an "all clear" state for an empty list, otherwise
// groups validation findings by frontmatter field.
const meta = {
  title: "Skills/SkillValidationSection",
  component: SkillValidationSection,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SkillValidationSection>

export default meta
type Story = StoryObj<typeof meta>

export const NoErrors: Story = {
  args: { errors: [] },
}

export const FieldErrors: Story = {
  args: {
    errors: [
      makeValidationError({ code: "name-too-long", field: "name" }),
      makeValidationError({
        code: "name-format",
        field: "name",
        message: "Name may only contain letters, numbers, and hyphens.",
      }),
      makeValidationError({
        code: "description-too-long",
        field: "description",
        message: "Description exceeds 1024 characters.",
      }),
    ],
  },
}

export const UnfieldedErrors: Story = {
  args: {
    errors: [
      makeValidationError({
        code: "frontmatter-parse",
        field: undefined,
        message: "Could not parse YAML frontmatter.",
      }),
      makeValidationError({
        code: "resource-path-traversal",
        field: undefined,
        message: "Resource path escapes the skill directory.",
      }),
    ],
  },
}
