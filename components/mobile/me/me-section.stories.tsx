import type { Meta, StoryObj } from "@storybook/nextjs"
import { BellIcon, KeyRoundIcon, ShieldCheckIcon } from "lucide-react"
import { fn } from "storybook/test"

import { MeSection } from "./me-section"
import { MeRow } from "./me-row"

// Section wrapper: small-caps heading over an ItemGroup of MeRows. Stories show
// the plain group and the `withSeparators` variant.
const meta = {
  title: "Mobile/Me/MeSection",
  component: MeSection,
  parameters: { layout: "padded" },
  args: {
    title: "Security",
    children: (
      <>
        <MeRow icon={ShieldCheckIcon} label="Biometric lock" href="/me/security" />
        <MeRow icon={KeyRoundIcon} label="API keys" onClick={fn()} />
        <MeRow icon={BellIcon} label="Notifications" value="On" onClick={fn()} />
      </>
    ),
  },
  decorators: [
    (Story) => (
      <div className="w-[360px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MeSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithDescription: Story = {
  args: { description: "Manage how this device keeps your data safe." },
}

export const WithSeparators: Story = {
  args: { withSeparators: true },
}
