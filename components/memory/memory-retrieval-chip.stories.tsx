import type { Meta, StoryObj } from "@storybook/nextjs"

import { MemoryRetrievalChip } from "./memory-retrieval-chip"

// The header status chip for memory recall. It answers a question the old
// layout never did — whether recall is actually hybrid — and hides the full
// retrieval control plane behind a popover instead of a permanent page band.
const meta = {
  title: "Memory/MemoryRetrievalChip",
  component: MemoryRetrievalChip,
  parameters: { layout: "centered" },
} satisfies Meta<typeof MemoryRetrievalChip>

export default meta
type Story = StoryObj<typeof meta>

export const Hybrid: Story = {
  args: { mode: { kind: "hybrid", provider: "local" } },
}

/** No vector backend configured — recall silently degrades to BM25. */
export const KeywordOnly: Story = {
  args: { mode: { kind: "bm25", reason: "no_backend" } },
}

export const Disabled: Story = {
  args: { mode: { kind: "off", reason: "disabled" } },
}

export const Probing: Story = {}
