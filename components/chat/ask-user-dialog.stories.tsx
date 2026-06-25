import type { Meta, StoryObj } from "@storybook/nextjs"

import { AskUserDialog } from "./ask-user-dialog"
import { useAskUserStore } from "@/stores/agent/ask-user-store"
import type { AskUserRequest } from "@/lib/claude/ask-user-tool"

// `AskUserDialog` is propless — it subscribes to `useAskUserStore` and renders
// the active `ask_user` prompt as a modal (returns null when idle). Each story
// seeds the store with a different pending request via `enqueue` so the dialog
// appears with the matching control set (single / multi / free-text).

const seed =
  (request: AskUserRequest, queued = 0) =>
  () => {
    const store = useAskUserStore.getState()
    // Clear any prior active prompt, then enqueue this one as the active request.
    store.resolveActive({ selected: [], text: "", cancelled: true })
    void store.enqueue(request)
    for (let i = 0; i < queued; i += 1) {
      void store.enqueue({ ...request, question: `Queued prompt ${i + 1}` })
    }
  }

const singleChoice: AskUserRequest = {
  question: "Which deploy target should I push this build to?",
  options: [
    { label: "Production", value: "prod" },
    { label: "Staging", value: "staging" },
    { label: "Preview (PR)", value: "preview" },
  ],
  multiSelect: false,
  allowText: false,
}

const multiSelect: AskUserRequest = {
  question: "Select every workspace I should run the migration against:",
  options: [
    { label: "Main app", value: "app" },
    { label: "Docs", value: "docs" },
    { label: "Mobile shell", value: "mobile" },
    { label: "Sidecar", value: "sidecar" },
  ],
  multiSelect: true,
  allowText: true,
}

const freeText: AskUserRequest = {
  question: "What commit message should I use for this change?",
  options: [],
  multiSelect: false,
  allowText: true,
}

const meta = {
  title: "Chat/AskUserDialog",
  component: AskUserDialog,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AskUserDialog>

export default meta
type Story = StoryObj<typeof meta>

// Single-select radio prompt — one option, no free text.
export const SingleChoice: Story = {
  beforeEach: seed(singleChoice),
}

// Multi-select with checkboxes plus a free-text field, and queued prompts behind.
export const MultiSelectWithQueue: Story = {
  beforeEach: seed(multiSelect, 2),
}

// Free-text-only prompt (no options) — just the textarea + submit.
export const FreeText: Story = {
  beforeEach: seed(freeText),
}
