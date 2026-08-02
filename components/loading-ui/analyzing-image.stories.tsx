import type { Meta, StoryObj } from "@storybook/nextjs"

import { AnalyzingImage } from "./analyzing-image"

// The indicator has no intrinsic size — both glyph layers are `absolute
// inset-0` — so every story sets one, and `text-*` drives the stroke colour.
const meta = {
  title: "LoadingUI/AnalyzingImage",
  component: AnalyzingImage,
  parameters: { layout: "centered" },
  args: { label: "Analyzing image…" },
} satisfies Meta<typeof AnalyzingImage>

export default meta
type Story = StoryObj<typeof meta>

/** The size the composer's attachment chips use. */
export const ChipSize: Story = {
  args: { className: "size-4 text-muted-foreground" },
}

/** Blown up — this is where the scan bar and the pixel fill are legible. */
export const Large: Story = {
  args: { className: "size-24 text-foreground" },
}

/**
 * On a translucent surface. The registry original painted an opaque
 * `var(--background)` rect here and read as a solid patch; the shipped version
 * clips its two glyph layers complementarily and paints nothing but strokes.
 */
export const OnTranslucentSurface: Story = {
  args: { className: "size-16 text-foreground" },
  decorators: [
    (Story) => (
      <div className="rounded-2xl bg-[repeating-linear-gradient(45deg,var(--color-muted),var(--color-muted)_8px,transparent_8px,transparent_16px)] p-6">
        <div className="rounded-xl border border-input/60 bg-background/70 p-4">
          <Story />
        </div>
      </div>
    ),
  ],
}
