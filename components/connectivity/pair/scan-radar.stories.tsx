import type { Meta, StoryObj } from "@storybook/nextjs"

import { ScanRadar } from "./scan-radar"

// Decorative radar shown above the discovered-server list. Pure + presentational:
// `active` toggles the expanding-rings animation; otherwise the rings sit static.
const meta = {
  title: "Mobile/Pair/ScanRadar",
  component: ScanRadar,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="mx-auto flex w-[390px] justify-center p-8">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ScanRadar>

export default meta
type Story = StoryObj<typeof meta>

/** Animating rings — a scan is in flight. */
export const Scanning: Story = { args: { active: true } }

/** Static rings — idle between scans. */
export const Idle: Story = { args: { active: false } }
