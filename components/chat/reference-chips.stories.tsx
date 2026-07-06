import type { Meta, StoryObj } from "@storybook/nextjs"

import { ReferenceChips } from "./reference-chips"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useChatStore, type FileReference } from "@/stores/chat"

// Visual list of files/folders the user has @-referenced for the next turn.
// Reads `referencedPaths` from the chat store; click the X to remove one.
const ref = (over: Partial<FileReference>): FileReference => ({
  absolute: "/repo/app/page.tsx",
  relative: "app/page.tsx",
  isDir: false,
  ...over,
})

const seedRefs = (refs: FileReference[]) => () => {
  resetStore(useChatStore)
  for (const r of refs) useChatStore.getState().addReferencedPath(r)
}

const meta = {
  title: "Chat/ReferenceChips",
  component: ReferenceChips,
  parameters: { layout: "padded" },
  beforeEach: seedRefs([
    ref({ absolute: "/repo/app/page.tsx", relative: "app/page.tsx", isDir: false }),
    ref({ absolute: "/repo/lib", relative: "lib", isDir: true }),
  ]),
} satisfies Meta<typeof ReferenceChips>

export default meta
type Story = StoryObj<typeof meta>

/** A file and a folder reference. */
export const FilesAndFolders: Story = {}

/** Bare mode — chips only, no padded container (for embedding in a parent bar). */
export const Bare: Story = {
  args: { bare: true },
}

/** A single deeply-nested file with a long path (truncated). */
export const LongPath: Story = {
  beforeEach: seedRefs([
    ref({
      absolute: "/repo/components/chat/message-parts/mcp-renderers/read-card.tsx",
      relative: "components/chat/message-parts/mcp-renderers/read-card.tsx",
      isDir: false,
    }),
  ]),
}
