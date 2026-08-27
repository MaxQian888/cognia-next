import type { Meta, StoryObj } from "@storybook/nextjs"

import { ScheduleSuggestion } from "./schedule-suggestion"

/**
 * The row the composer renders under the input when what is being typed reads
 * as a recurring task. `debounceMs: 0` so the story settles immediately.
 */
const meta = {
  title: "Chat/Composer/ScheduleSuggestion",
  component: ScheduleSuggestion,
  parameters: { layout: "padded" },
  args: { debounceMs: 0 },
} satisfies Meta<typeof ScheduleSuggestion>

export default meta
type Story = StoryObj<typeof meta>

/** A Chinese line with an explicit cadence. */
export const RecurringZh: Story = {
  args: { value: "每天早上九点提醒我看一下 PR 列表" },
}

/** The same intent in English. */
export const RecurringEn: Story = {
  args: { value: "remind me every weekday to send the stand-up summary" },
}

/**
 * An ordinary request renders nothing at all — the row must never appear for a
 * one-off ask, which is the failure mode that makes a proactive suggestion
 * worse than no suggestion.
 */
export const NotRecurring: Story = {
  args: { value: "帮我把这个函数重构成更小的几块，顺便补上类型" },
}
