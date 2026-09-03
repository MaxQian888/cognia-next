import type { Meta, StoryObj } from "@storybook/nextjs"

import { ChatTemplatesSection } from "./chat-templates-section"
import { seedDb } from "@/lib/storybook/seed-db"
import { createChatTemplate } from "@/lib/db/chat-templates"

// Saved chat templates: rename, rewrite, duplicate, retire, and move one
// between this machine, a file, and a checkout. The table is read straight from
// Dexie, so stories seed rows through the same writer the composer uses. The
// repository scan resolves no workspace root in the Storybook browser, so the
// "from your repository" block stays absent.

async function seedTemplates(): Promise<void> {
  await seedDb(async () => {
    await createChatTemplate({
      name: "Review a pull request",
      description: "Read the diff, list the risks, and suggest tests.",
      body: "Review {{module}} on {{branch}}. Focus on {{concern}} and list every missing test.",
    })
    await createChatTemplate({
      name: "Write release notes",
      body: "Summarise the changes since {{tag}} as release notes for end users.",
    })
    await createChatTemplate({
      name: "Explain a failing test",
      description: "Paste the failure and get a root-cause walk-through.",
      body: "This test fails: {{output}}. Explain the root cause before proposing a fix.",
    })
  })
}

const meta = {
  title: "Settings/ChatTemplatesSection",
  component: ChatTemplatesSection,
  parameters: { layout: "padded" },
  args: { mobile: false },
  decorators: [
    (Story) => (
      <div className="w-full max-w-3xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ChatTemplatesSection>

export default meta
type Story = StoryObj<typeof meta>

/** Desktop two-column card layout with three saved templates. */
export const Desktop: Story = {
  beforeEach: seedTemplates,
}

/** The single-column layout the phone settings screen mounts. */
export const Mobile: Story = {
  args: { mobile: true },
  decorators: [
    (Story) => (
      <div className="w-[360px]">
        <Story />
      </div>
    ),
  ],
  beforeEach: seedTemplates,
}

/** Nothing saved yet. Import and the toolbar are still offered. */
export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
