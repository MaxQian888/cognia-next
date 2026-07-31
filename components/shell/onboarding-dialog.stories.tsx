import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { OnboardingDialog } from "./onboarding-dialog"

// Desktop first-run wizard (provider → character → tour). Rendered open so the
// AlertDialog content shows the provider step (Claude / Codex / OpenCode / API
// key cards). Characters come from Dexie (empty here); reuses the production
// AddAccount dialogs for the OAuth surfaces.
const meta = {
  title: "Shell/OnboardingDialog",
  component: OnboardingDialog,
  parameters: { layout: "fullscreen" },
  args: { open: true, onOpenChange: fn(), onPickCharacter: fn() },
} satisfies Meta<typeof OnboardingDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}
