import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { MobileSkillSheet } from "./mobile-skill-sheet"
import { makeSkill } from "@/lib/storybook/fixtures/mobile"

// Mobile skill detail sheet (Overview / Edit / Resources / Validation tabs).
// Pure: `skill` seeds the form; `updateSkill` only runs on Save. Opens on the
// Overview tab — the Resources tab's Dexie reads stay deferred until tapped.
const meta = {
  title: "Mobile/Skills/MobileSkillSheet",
  component: MobileSkillSheet,
  parameters: { layout: "fullscreen" },
  args: { open: true, onOpenChange: fn() },
} satisfies Meta<typeof MobileSkillSheet>

export default meta
type Story = StoryObj<typeof meta>

/** A healthy custom skill. */
export const Default: Story = {
  args: { skill: makeSkill() },
}

/** A skill with non-fatal validation issues (badged on the Validation tab). */
export const WithValidationErrors: Story = {
  args: {
    skill: makeSkill({
      name: "Broken skill",
      validationErrors: [
        { code: "missing-frontmatter", message: "Frontmatter `name` is missing", severity: "warning" },
      ] as never,
    }),
  },
}
