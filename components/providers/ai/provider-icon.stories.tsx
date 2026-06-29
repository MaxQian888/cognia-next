import type { Meta, StoryObj } from "@storybook/nextjs"

import { ProviderIcon } from "./provider-icon"

// `ProviderIcon` is a props-only leaf: it renders a monogram fallback (the
// uppercased first letter of `providerId`) inside a muted rounded square. No
// store, Dexie, or i18n — every visible state is reachable purely from props.
const meta = {
  title: "Providers/ProviderIcon",
  component: ProviderIcon,
  parameters: { layout: "centered" },
  args: { providerId: "openai" },
} satisfies Meta<typeof ProviderIcon>

export default meta
type Story = StoryObj<typeof meta>

/** Default 24px monogram derived from the provider id's first letter. */
export const Default: Story = {}

/** A different provider id yields a different monogram letter. */
export const Anthropic: Story = {
  args: { providerId: "anthropic" },
}

/** Empty / missing id falls back to the `?` placeholder glyph. */
export const UnknownProvider: Story = {
  args: { providerId: "" },
}

/** `size` overrides the default 24px box via inline width/height. */
export const Large: Story = {
  args: { providerId: "google", size: 64 },
}

/** A row of monograms showing the per-letter fallback across providers. */
export const Gallery: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      {["openai", "anthropic", "google", "mistral", "deepseek", "xai"].map((id) => (
        <ProviderIcon key={id} providerId={id} size={40} />
      ))}
    </div>
  ),
}
