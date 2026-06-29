import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { CharacterDetailSheet } from "./character-detail-sheet"
import { makeCharacter } from "@/lib/storybook/fixtures/mobile-discover"

// Bottom-sheet character editor. Pure w.r.t. rendering — persistence (Dexie +
// outbound queue) only fires on Save/Delete. `character: null` is the create
// form; a character switches it to edit (with a Delete action for non-builtins).
const meta = {
  title: "Mobile/Discover/CharacterDetailSheet",
  component: CharacterDetailSheet,
  parameters: { layout: "fullscreen" },
  args: { open: true, character: null, onOpenChange: fn() },
} satisfies Meta<typeof CharacterDetailSheet>

export default meta
type Story = StoryObj<typeof meta>

export const Create: Story = {}

export const Edit: Story = {
  args: {
    character: makeCharacter({ name: "Octopus Tutor", description: "Explains things with analogies." }),
  },
}

export const EditBuiltIn: Story = {
  args: {
    character: makeCharacter({ name: "Built-in helper", isBuiltIn: true }),
  },
}
