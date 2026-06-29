import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PetModelConfigDialog } from "./pet-model-config-dialog"
import { makePetModelRow } from "@/lib/storybook/fixtures/pet"

// Per-model customization dialog (Transform + Motion tabs over a live preview).
// The Live2D canvas needs the Cubism core runtime, which isn't loaded in the
// Storybook browser — `useCubismCoreAvailable()` returns false, so the preview
// shows its "unavailable" note and the Transform/Motion editors render below.
const meta = {
  title: "Settings/Pet/PetModelConfigDialog",
  component: PetModelConfigDialog,
  parameters: { layout: "fullscreen" },
  args: {
    model: makePetModelRow(),
    open: true,
    onOpenChange: fn(),
  },
} satisfies Meta<typeof PetModelConfigDialog>

export default meta
type Story = StoryObj<typeof meta>

// Hiyori with three motion groups + expressions to map.
export const Default: Story = {}

// A model that declares no motion groups / expressions — the motion editor
// offers only the default / engine sentinels.
export const MinimalModel: Story = {
  args: {
    model: makePetModelRow({
      id: "pm_story_minimal",
      name: "Plain Model",
      motionGroups: [],
      expressionIds: [],
    }),
  },
}
