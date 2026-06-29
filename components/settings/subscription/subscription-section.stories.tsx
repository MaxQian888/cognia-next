import type { Meta, StoryObj } from "@storybook/nextjs"

import { SubscriptionSection } from "./subscription-section"

// `SubscriptionSection` is the propless top-level Settings → Subscription
// surface. It drives the active provider / inner tab from the URL search params
// (`?subTab=`, `?innerTab=`) via the App Router mocks the Storybook preview
// supplies, and composes the three provider tabs with the section-level
// import/export + cloud-sync cards. Everything below renders its
// empty / web-mode branch in the non-Tauri browser.
const meta = {
  title: "Settings/Subscription/SubscriptionSection",
  component: SubscriptionSection,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-3xl p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SubscriptionSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
