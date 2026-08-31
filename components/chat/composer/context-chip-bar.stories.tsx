import type { Meta, StoryObj } from "@storybook/nextjs"

import { ContextChipBar } from "./context-chip-bar"
import { PromptInputProvider } from "@/components/ai-elements/prompt-input"
import { StagedAttachmentsProvider } from "./staged-attachment-store"
import { useChatStore } from "@/stores/chat"
import type { FileReference } from "@/stores/chat/chat-store"
import type { ArtifactSelectionRef } from "@/types/artifact/artifact"

// ContextChipBar composes three chip sets in one flex flow:
//  - @-referenced files/folders + artifact selections, both read synchronously
//    from the chat store (seeded here via setState)
//  - staged attachments, read from `StagedAttachmentsProvider` (left empty —
//    its chips are exercised by the AttachmentPreview story). That provider is
//    required, not optional: `useStagedAttachments` throws without it, so the
//    story rendered nothing but Storybook's error panel until it was added.
const refs: FileReference[] = [
  {
    absolute: "/Users/dev/cognia-next/lib/claude/build-options.ts",
    relative: "lib/claude/build-options.ts",
    isDir: false,
  },
  {
    absolute: "/Users/dev/cognia-next/components/chat/composer",
    relative: "components/chat/composer",
    isDir: true,
  },
]

const selections: ArtifactSelectionRef[] = [
  {
    kind: "artifact",
    artifactId: "art-1",
    title: "resolveSendOptions",
    snapshot: "export function resolveSendOptions() { /* … */ }",
    comment: "Use the per-channel A2UI capability prompt here",
    range: { startLine: 42, endLine: 58 },
  },
]

function seed(state: { refs: FileReference[]; selections: ArtifactSelectionRef[] }) {
  return async () => {
    useChatStore.setState({
      referencedPaths: state.refs,
      contextSelections: state.selections,
    })
  }
}

const meta = {
  title: "Chat/Composer/ContextChipBar",
  component: ContextChipBar,
  parameters: { layout: "padded" },
  beforeEach: seed({ refs, selections }),
  decorators: [
    (Story: () => React.ReactElement) => (
      <PromptInputProvider>
        <StagedAttachmentsProvider>
          <div className="w-full max-w-2xl rounded-md border">
            <Story />
          </div>
        </StagedAttachmentsProvider>
      </PromptInputProvider>
    ),
  ],
} satisfies Meta<typeof ContextChipBar>

export default meta
type Story = StoryObj<typeof meta>

// File + folder references alongside an artifact selection chip.
export const ReferencesAndArtifact: Story = {}

// Only @-referenced paths, no artifact selection.
export const ReferencesOnly: Story = {
  beforeEach: seed({ refs, selections: [] }),
}
