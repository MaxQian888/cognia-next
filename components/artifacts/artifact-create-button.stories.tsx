import type { Meta, StoryObj } from "@storybook/nextjs"

import { ArtifactCreateButton } from "./artifact-create-button"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useArtifactStore } from "@/stores/artifact/artifact-store"

const SAMPLE = `function quicksort(xs: number[]): number[] {
  if (xs.length <= 1) return xs
  const [pivot, ...rest] = xs
  return [
    ...quicksort(rest.filter((x) => x < pivot)),
    pivot,
    ...quicksort(rest.filter((x) => x >= pivot)),
  ]
}
`

// Creates an artifact from a code block. The three `variant`s are the
// meaningful surfaces; creation writes to the artifact store, so reset it.
const meta = {
  title: "Artifacts/ArtifactCreateButton",
  component: ArtifactCreateButton,
  args: { content: SAMPLE, language: "typescript", title: "quicksort.ts" },
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useArtifactStore)
  },
} satisfies Meta<typeof ArtifactCreateButton>

export default meta
type Story = StoryObj<typeof meta>

export const Icon: Story = {
  args: { variant: "icon" },
}

export const Button: Story = {
  args: { variant: "button" },
}

export const Dropdown: Story = {
  args: { variant: "dropdown" },
}
