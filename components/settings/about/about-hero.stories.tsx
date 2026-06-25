import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { AboutHero } from "./about-hero"

// AboutHero takes no props — it reads app metadata and platform flags. In the
// Storybook browser `isTauri()`/`isCapacitor()` are false, so the "web" badge
// renders and the version line comes from the bundled APP_VERSION. Toggle the
// Locale toolbar to see the channel/tagline strings in English vs. 简体中文.
const meta = {
  title: "Settings/About/AboutHero",
  component: AboutHero,
  parameters: { layout: "padded" },
} satisfies Meta<typeof AboutHero>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

/** Constrained to a card-like column, as it sits inside the About page. */
export const InColumn: Story = {
  render: () => (
    <div className="max-w-xl">
      <AboutHero />
    </div>
  ),
}
