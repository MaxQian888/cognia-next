import type { Meta, StoryObj } from "@storybook/nextjs"

import { LegalCreditsCard } from "./legal-credits-card"

// Pure presentational card: copyright line + licence/privacy links +
// open-source acknowledgement badges. The only input is the optional
// `currentYear` seam (defaults to `new Date().getFullYear()`), which drives
// whether the copyright shows a single year or a range. `openExternal` is fired
// by the link/badge clicks; outside Tauri it's a harmless no-op.
const meta = {
  title: "Settings/About/LegalCreditsCard",
  component: LegalCreditsCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof LegalCreditsCard>

export default meta
type Story = StoryObj<typeof meta>

/** Default: current year (resolved internally). */
export const Default: Story = {}

/** A later year renders the "start–current" copyright range. */
export const YearRange: Story = {
  args: { currentYear: 2030 },
}
