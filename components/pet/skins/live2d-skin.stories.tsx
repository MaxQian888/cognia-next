import type { Meta, StoryObj } from "@storybook/nextjs"

import { live2dSkin } from "./live2d-skin"
import type { PetSkinRenderProps } from "@/types/pet"
import { makePetBones } from "@/lib/storybook/fixtures/pet-core"

// The Live2D skin resolves the active model (Dexie) and lazy-loads a pixi canvas
// inside Suspense + an ErrorBoundary. With no imported model — the Storybook
// default — it degrades to the SVG skin's content, which is exactly what these
// stories exercise (the heavy WebGL canvas only mounts once a model exists).
function Live2dSkin(props: PetSkinRenderProps) {
  return <>{live2dSkin.render(props)}</>
}

const meta = {
  title: "Pet/Skins/Live2dSkin",
  component: Live2dSkin,
  parameters: { layout: "centered" },
  args: {
    bones: makePetBones(),
    stage: "adult",
    state: "idle",
    oneShot: null,
    reducedMotion: false,
    size: 180,
  },
  decorators: [
    (Story) => (
      <div className="flex h-[260px] w-[260px] items-center justify-center">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Live2dSkin>

export default meta
type Story = StoryObj<typeof meta>

// No active model → SVG fallback content.
export const FallbackToSvg: Story = {}

export const FallbackHappy: Story = { args: { state: "happy", oneShot: "love" } }
