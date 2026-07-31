import type { Meta, StoryObj } from "@storybook/nextjs"

import { AlertBlock } from "./alert-block"

// GitHub-style admonition block (note / tip / important / warning / caution)
// used by the markdown renderer for `> [!NOTE]` blockquotes.
const meta = {
  title: "Chat/Renderers/AlertBlock",
  component: AlertBlock,
  parameters: { layout: "padded" },
  args: {
    type: "note",
    children: "Static export means there is no runtime server — plan accordingly.",
  },
} satisfies Meta<typeof AlertBlock>

export default meta
type Story = StoryObj<typeof meta>

export const Note: Story = { args: { type: "note" } }

export const Tip: Story = {
  args: { type: "tip", children: "Use `Promise.all` to fan out independent awaits." },
}

export const Important: Story = {
  args: { type: "important", children: "Install from the repo root — there is a single lockfile." },
}

export const Warning: Story = {
  args: { type: "warning", children: 'Do not remove `output: "export"` in next.config.ts.' },
}

export const Caution: Story = {
  args: { type: "caution", children: "Bypassing the PII gate sends raw text to the model." },
}

/** A custom title overrides the default type label. */
export const CustomTitle: Story = {
  args: { type: "tip", title: "Pro tip", children: "Collocate the test next to the component." },
}

/** Collapsible variant — starts open; click the header to toggle. */
export const Collapsible: Story = {
  args: {
    type: "important",
    collapsible: true,
    defaultOpen: true,
    children: "This block can be collapsed to save vertical space in a long answer.",
  },
}
