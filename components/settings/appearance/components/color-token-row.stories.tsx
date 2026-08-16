import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState } from "react"
import { fn } from "storybook/test"

import { ColorTokenRow } from "./color-token-row"

// Pure presentational row: label + native color swatch + hex text input. Owns
// no state; an invalid hex marks the input destructive and the swatch falls
// back to gray. The stories keep local state so the swatch + hex stay in sync.
function Harness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial)
  return (
    <div className="max-w-md">
      <ColorTokenRow tokenKey="primary" label="Primary" value={value} onChange={setValue} />
    </div>
  )
}

// Multi-column layout here sizes off `@container/appearance-pane`, which
// `appearance-section.tsx` owns in the real app — the decorator stands in for
// it so this story previews the same layout the settings pane shows.
const meta = {
  title: "Settings/Appearance/ColorTokenRow",
  component: ColorTokenRow,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="@container/appearance-pane">
        <Story />
      </div>
    ),
  ],
  args: { tokenKey: "primary", label: "Primary", value: "#7c4dff", onChange: fn() },
} satisfies Meta<typeof ColorTokenRow>

export default meta
type Story = StoryObj<typeof meta>

// Valid hex → swatch matches the value.
export const Valid: Story = {
  render: () => <Harness initial="#7c4dff" />,
}

// Invalid hex → destructive input, gray swatch fallback.
export const Invalid: Story = {
  render: () => <Harness initial="not-a-color" />,
}

// With a helper hint and disabled inputs.
export const DisabledWithHint: Story = {
  args: { value: "#1e293b", disabled: true, hint: "Locked by the active theme pack." },
}
