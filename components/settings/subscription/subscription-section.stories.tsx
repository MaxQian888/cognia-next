import type { Meta, StoryObj } from "@storybook/nextjs"

import { SubscriptionSection } from "./subscription-section"

// `SubscriptionSection` is the propless top-level Settings → Subscription
// surface: a master/detail shell whose active panel comes from `?subTab=` via
// the App Router mocks the Storybook preview supplies. Everything below renders
// its empty / web-mode branch in the non-Tauri browser.
//
// The section is a member of the settings shell's `FILL_HEIGHT_SECTIONS` and
// owns its own scroll, so the decorator gives it a fixed-height box — without
// one the `h-full` chain collapses and the nav/detail panes have nothing to
// fill.
const meta = {
  title: "Settings/Subscription/SubscriptionSection",
  component: SubscriptionSection,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="mx-auto h-[720px] max-w-5xl p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SubscriptionSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
