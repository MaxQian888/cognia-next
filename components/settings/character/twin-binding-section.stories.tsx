import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TwinBindingSection } from "./twin-binding-section"

// `TwinBindingSection` links a character to a digital twin. It's prop-driven
// (`value` + `onChange`) and reads twin stats from Dexie via `useLiveQuery`.
// With an empty Storybook IndexedDB the live stats resolve to zero, so the two
// meaningful states are unbound (Bind affordance) and bound (runtime knobs).
const meta = {
  title: "Settings/Character/TwinBindingSection",
  component: TwinBindingSection,
  parameters: { layout: "padded" },
  args: {
    onChange: fn(),
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TwinBindingSection>

export default meta
type Story = StoryObj<typeof meta>

// Unbound — single Bind button + "create new twin" affordance.
export const Unbound: Story = {
  args: { value: {} },
}

// Bound — twin id + the four runtime knobs (RAG enable, top-K, style few-shot,
// samples-K) and the deep link into the twin workbench.
export const Bound: Story = {
  args: {
    value: {
      twinId: "twin_demo01",
      twinSettings: { enableRag: true, ragTopK: 6 },
    },
  },
}
