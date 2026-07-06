import type { Meta, StoryObj } from "@storybook/nextjs"

import { SkillUrlInstallDialog } from "./skill-url-install-dialog"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSkillsStore } from "@/stores/skills/skills-store"

// Open state lives in `useSkillsStore.urlInstallOpen`. Seed it open so the
// dialog renders; install resolution only fires on submit.
const meta = {
  title: "Skills/SkillUrlInstallDialog",
  component: SkillUrlInstallDialog,
  parameters: { layout: "centered" },
  beforeEach: () => {
    resetStore(useSkillsStore)
    seedStore(useSkillsStore, { urlInstallOpen: true })
  },
} satisfies Meta<typeof SkillUrlInstallDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}
