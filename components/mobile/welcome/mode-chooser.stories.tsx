import type { Meta, StoryObj } from "@storybook/nextjs"

import { ModeChooser } from "./mode-chooser"

// First-run onboarding chooser: standalone (BYOK) vs pair-with-desktop. Propless;
// the choice persists via `setMobileRuntimeMode` and navigates on tap (router is
// mocked by the Storybook App Router provider), so the two-card layout renders
// directly.
const meta = {
  title: "Mobile/Welcome/ModeChooser",
  component: ModeChooser,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[390px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ModeChooser>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
