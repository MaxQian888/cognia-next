import type { Meta, StoryObj } from "@storybook/nextjs"

import { KbdInline, KeyboardShortcut } from "./kbd-inline"

const meta = {
  title: "Chat/Renderers/KbdInline",
  component: KbdInline,
  parameters: { layout: "padded" },
  args: { children: "Enter" },
} satisfies Meta<typeof KbdInline>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Outline: Story = {
  args: { variant: "outline", children: "Esc" },
}

export const Ghost: Story = {
  args: { variant: "ghost", children: "Tab" },
}

// In-prose usage — a single key rendered inside a sentence.
export const InProse: Story = {
  render: () => (
    <p className="text-sm">
      Press <KbdInline>/</KbdInline> to open the command palette, then <KbdInline>Enter</KbdInline>{" "}
      to run.
    </p>
  ),
}

// Multi-key chord via KeyboardShortcut — keys are platform-formatted.
export const Shortcut: Story = {
  render: () => (
    <div className="flex flex-col gap-3 text-sm">
      <KeyboardShortcut keys={["cmd", "k"]} />
      <KeyboardShortcut keys={["ctrl", "shift", "p"]} variant="outline" />
      <KeyboardShortcut keys={["alt", "enter"]} variant="ghost" />
    </div>
  ),
}
