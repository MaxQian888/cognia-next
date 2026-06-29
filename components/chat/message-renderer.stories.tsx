import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ReactNode } from "react"
import type { UIMessage } from "ai"
import { fn } from "storybook/test"

import { MessageRenderer } from "./message-renderer"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useChatStore } from "@/stores/chat"

// One chat message (user or assistant) with its avatar, parts, and hover action
// bar. Pass a fake `message` typed as UIMessage; reasoning / tool / text parts
// each route to their renderer.
const mockAdapter: DataAdapter = {
  useCharacters: () => [],
  useCharacter: () => undefined,
  useSkillsByIds: () => [],
  usePresets: () => [],
  clearMessages: async () => {},
  updateSession: async () => {},
  recordPresetUsage: async () => {},
  trustWorkspace: async () => {},
}

const withAdapter = (Story: () => ReactNode) => (
  <DataAdapterProvider adapter={mockAdapter}>
    <div className="mx-auto max-w-2xl p-4">
      <Story />
    </div>
  </DataAdapterProvider>
)

const user = (text: string): UIMessage =>
  ({
    id: "u1",
    role: "user",
    parts: [{ type: "text", text, state: "done" }],
  }) as unknown as UIMessage

const assistant = (text: string, extra: unknown[] = []): UIMessage =>
  ({
    id: "a1",
    role: "assistant",
    parts: [...extra, { type: "text", text, state: "done" }],
  }) as unknown as UIMessage

const meta = {
  title: "Chat/MessageRenderer",
  component: MessageRenderer,
  parameters: { layout: "fullscreen" },
  decorators: [withAdapter],
  args: {
    message: assistant("Here is a concise answer to your question."),
    isLastAssistant: true,
    onCopy: fn(),
    onRegenerate: fn(),
    onEditResend: fn(),
  },
  beforeEach: () => {
    resetStore(useChatStore)
    useChatStore.getState().setActiveSession("demo-session")
  },
} satisfies Meta<typeof MessageRenderer>

export default meta
type Story = StoryObj<typeof meta>

/** A plain assistant turn. */
export const AssistantText: Story = {}

/** A user turn (right-aligned bubble). */
export const UserMessage: Story = {
  args: { message: user("Explain closures in one sentence."), isLastAssistant: false },
}

/** Markdown-rich assistant answer. */
export const RichMarkdown: Story = {
  args: {
    message: assistant(
      [
        "## Steps",
        "",
        "1. Read the file",
        "2. Apply the edit",
        "",
        "```ts",
        "const x = 1",
        "```",
      ].join("\n")
    ),
  },
}

/** Assistant turn with a visible reasoning part before the answer. */
export const WithReasoning: Story = {
  args: {
    message: assistant("Yes, 127 and 131 are both prime.", [
      { type: "reasoning", text: "Check divisibility up to √n for each.", state: "done" },
    ]),
  },
}

/** Assistant turn that invoked a tool. */
export const WithToolCall: Story = {
  args: {
    message: assistant("This is what app/page.tsx contains:", [
      {
        type: "tool-Read",
        toolCallId: "c1",
        state: "output-available",
        input: { file_path: "app/page.tsx" },
        output: "export default function Home() { return null }",
      },
    ]),
  },
}

/** Mid-stream assistant turn (streaming caret). */
export const Streaming: Story = {
  args: {
    message: {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "Let me think", state: "streaming" }],
    } as unknown as UIMessage,
    isStreaming: true,
  },
}
