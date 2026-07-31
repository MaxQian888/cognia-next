import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { DraftEditorDialog } from "./draft-editor-dialog"
import { makeTwinDraft } from "@/lib/storybook/fixtures/twin"

// Pure props-only edit-before-accept dialog. The visible fields depend on the
// draft kind (character → name/description/systemPrompt/voiceSummary;
// skill → name/description/content). `onSave` is a spy.
const meta = {
  title: "Twin/DraftEditorDialog",
  component: DraftEditorDialog,
  parameters: { layout: "centered" },
  args: {
    open: true,
    onOpenChange: fn(),
    onSave: fn(async () => {}),
    draft: makeTwinDraft(),
  },
} satisfies Meta<typeof DraftEditorDialog>

export default meta
type Story = StoryObj<typeof meta>

export const CharacterDraft: Story = {}

export const SkillDraft: Story = {
  args: {
    draft: makeTwinDraft({
      kind: "skill",
      payload: {
        kind: "skill",
        data: {
          name: "Refund Workflow",
          description: "Steps to process a customer refund.",
          content: "# Refund Workflow\n\n1. Verify eligibility.\n2. Issue refund.\n",
        },
        sourcePlaybookId: "playbook-1",
      },
    }),
  },
}

export const Saving: Story = {
  args: { busy: true },
}
