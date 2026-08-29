import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { useTranslations } from "next-intl"
import { fn } from "storybook/test"

import { EmptyChatState } from "./empty-state"

const meta = {
  title: "Chat/EmptyChatState",
  component: EmptyChatState,
  args: {
    onCreate: fn(),
    onUseSample: fn(),
    aiSamples: [
      "Summarize the key risks in this codebase.",
      "Write a unit test for the selected function.",
      "Explain this stack trace and suggest a fix.",
    ],
  },
} satisfies Meta<typeof EmptyChatState>

export default meta
type Story = StoryObj<typeof meta>

function ComposerFixture() {
  const t = useTranslations("chat.composer")
  return (
    <div className="rounded-2xl border bg-card p-3">
      <p className="px-1 py-6 font-mono text-sm text-muted-foreground">{t("placeholder")}</p>
      <div className="flex items-center gap-3 text-muted-foreground">
        <span className="size-5 rounded bg-muted" />
        <span className="size-5 rounded bg-muted" />
        <span className="size-5 rounded bg-muted" />
        <span className="h-3 w-24 rounded bg-muted" />
        <span className="ml-auto size-8 rounded-lg bg-muted" />
      </div>
    </div>
  )
}

function ExecutionControlsFixture() {
  const t = useTranslations("chat.empty")
  return (
    <span className="rounded-pill border px-2.5 py-1 text-xs text-muted-foreground">
      {t("execution.local")}
    </span>
  )
}

export const Fullscreen: Story = {
  args: { variant: "fullscreen" },
  parameters: { layout: "fullscreen" },
}

export const Inline: Story = {
  args: { variant: "inline" },
}

export const WithUserName: Story = {
  args: { variant: "fullscreen", userName: "Max" },
  parameters: { layout: "fullscreen" },
}

/**
 * The production shape of the no-session welcome: a live composer under the
 * greeting, which is what actually starts the chat. `New chat` demotes to a
 * ghost beside the execution picker below the box.
 */
export const WithComposer: Story = {
  args: {
    variant: "fullscreen",
    userName: "Max",
    composerSlot: <ComposerFixture />,
    executionControlsSlot: <ExecutionControlsFixture />,
  },
  parameters: { layout: "fullscreen" },
}
