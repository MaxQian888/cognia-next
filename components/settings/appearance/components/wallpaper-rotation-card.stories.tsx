import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { useState } from "react"

import { WallpaperRotationCard } from "./wallpaper-rotation-card"
import {
  DEFAULT_WALLPAPER_ROTATION,
  type WallpaperRotationSettings,
} from "@/types/appearance/wallpaper-rotation"
import type { Wallpaper } from "@/types/appearance"

function image(id: string, name: string): Wallpaper {
  return {
    id,
    name,
    kind: "image",
    source: {
      kind: "image",
      storage: "data-url",
      dataUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      mime: "image/gif",
      width: 1920,
      height: 1080,
    },
    builtin: false,
    createdAt: 0,
  }
}

const gallery: Wallpaper[] = [
  image("wp-1", "Aurora"),
  image("wp-2", "Harbour at dusk"),
  image("wp-3", "Deep field"),
  {
    id: "wp-grad",
    name: "Sunset gradient",
    kind: "gradient",
    source: { kind: "gradient", css: "linear-gradient(135deg, #ff7e5f, #feb47b)" },
    builtin: true,
    createdAt: 0,
  },
]

/** Live wrapper, so the story exercises the real state transitions. */
function Harness(props: {
  initial?: Partial<WallpaperRotationSettings>
  scrimActive?: boolean
  gallery?: Wallpaper[]
}) {
  const [rotation, setRotation] = useState<WallpaperRotationSettings>({
    ...DEFAULT_WALLPAPER_ROTATION,
    enabled: true,
    ...props.initial,
  })
  return (
    <div className="max-w-xl p-4">
      <WallpaperRotationCard
        rotation={rotation}
        gallery={props.gallery ?? gallery}
        scrimActive={props.scrimActive ?? false}
        onChange={(patch) => setRotation((prev) => ({ ...prev, ...patch }))}
      />
    </div>
  )
}

const meta: Meta<typeof Harness> = {
  title: "Settings/Appearance/WallpaperRotationCard",
  component: Harness,
}
export default meta

type Story = StoryObj<typeof Harness>

export const Enabled: Story = { args: {} }

export const Disabled: Story = { args: { initial: { enabled: false } } }

export const SlideTransition: Story = {
  args: { initial: { transition: "slide", slideDirection: "up", transitionMs: 1400 } },
}

export const DailyTrigger: Story = { args: { initial: { trigger: "daily" } } }

/** The scrim owns the layer a crossfade needs, so the card explains the downgrade. */
export const DegradedByScrim: Story = {
  args: { initial: { transition: "crossfade" }, scrimActive: true },
}

/** A curated playlist rather than the implicit "everything". */
export const ExplicitPlaylist: Story = {
  args: { initial: { playlist: ["wp-2", "wp-3"] } },
}

/** Nothing to rotate to yet. */
export const NotEnoughWallpapers: Story = {
  args: { gallery: [image("only", "The only one")] },
}
