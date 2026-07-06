import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState } from "react"
import { fn } from "storybook/test"

import { FontFamilyPicker } from "./font-family-picker"

// Font-family Select backed by the live font registry (web-safe + system +
// plugin). Returns the picked CSS family via `onChange`; undefined means
// inherit the cognia default. The stories keep local state.
function Harness({ initial, monoOnly }: { initial: string | undefined; monoOnly?: boolean }) {
  const [value, setValue] = useState<string | undefined>(initial)
  return (
    <div className="max-w-xs">
      <FontFamilyPicker
        labelKey={monoOnly ? "font.monoLabel" : "font.sansLabel"}
        hintKey={monoOnly ? undefined : "font.sansHint"}
        value={value}
        onChange={setValue}
        monoOnly={monoOnly}
      />
    </div>
  )
}

const meta = {
  title: "Settings/Appearance/FontFamilyPicker",
  component: FontFamilyPicker,
  parameters: { layout: "padded" },
  args: { labelKey: "font.sansLabel", value: undefined, onChange: fn() },
} satisfies Meta<typeof FontFamilyPicker>

export default meta
type Story = StoryObj<typeof meta>

// Inherit (no explicit family).
export const Inherit: Story = {
  render: () => <Harness initial={undefined} />,
}

// A concrete sans family selected.
export const SansSelected: Story = {
  render: () => <Harness initial="Georgia" />,
}

// Monospace-only variant for the terminal font picker.
export const MonospaceOnly: Story = {
  render: () => <Harness initial={undefined} monoOnly />,
}
