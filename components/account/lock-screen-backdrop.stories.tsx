import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { LockScreenBackdrop } from "./lock-screen-backdrop"
import { DEFAULT_LOCK_SCREEN, type LockScreenSettings } from "@/types/appearance/lock-screen"
import type { Wallpaper } from "@/types/appearance"

/** A small inline gradient stands in for a photographic wallpaper. */
const wallpaper: Wallpaper = {
  id: "wp-1",
  name: "Aurora",
  kind: "gradient",
  source: { kind: "gradient", css: "linear-gradient(135deg, #6366f1, #ec4899, #f59e0b)" },
  builtin: true,
  createdAt: 0,
}

function Harness(props: { settings?: Partial<LockScreenSettings> }) {
  const settings = { ...DEFAULT_LOCK_SCREEN, ...props.settings }
  return (
    <div className="relative flex min-h-[520px] items-center justify-center overflow-hidden">
      <LockScreenBackdrop
        settings={settings}
        activeWallpaperId="wp-1"
        wallpapers={[wallpaper]}
        now={new Date(2026, 8, 3, 9, 41)}
      />
      <div className="z-10 flex w-full max-w-sm flex-col items-center gap-4">
        <LockScreenBackdrop
          settings={settings}
          activeWallpaperId="wp-1"
          wallpapers={[wallpaper]}
          now={new Date(2026, 8, 3, 9, 41)}
        />
        <div className="w-full rounded-xl border bg-card p-6 text-card-foreground shadow-lg">
          <p className="text-sm font-medium">Unlock Ada</p>
          <div className="mt-3 h-9 rounded-md border bg-background" />
          <div className="mt-3 h-9 rounded-md bg-primary" />
        </div>
      </div>
    </div>
  )
}

const meta: Meta<typeof Harness> = {
  title: "Account/LockScreenBackdrop",
  component: Harness,
}
export default meta

type Story = StoryObj<typeof Harness>

export const PlainTheme: Story = { args: {} }

export const WallpaperWithClock: Story = {
  args: {
    settings: { backdrop: "wallpaper", clock: "timeAndDate", greeting: "timeOfDay", dim: 0.45 },
  },
}

export const HeavyBlur: Story = {
  args: { settings: { backdrop: "wallpaper", blurPx: 32, clock: "time", dim: 0.5 } },
}

/** The failure case the dim exists to prevent, shown at its floor. */
export const BarelyDimmed: Story = {
  args: { settings: { backdrop: "wallpaper", blurPx: 0, dim: 0.05, clock: "time" } },
}

export const Aurora: Story = {
  args: { settings: { backdrop: "theme", motion: "aurora", clock: "time", greeting: "timeOfDay" } },
}

export const SolidColour: Story = {
  args: { settings: { backdrop: "solid", solidColor: "#0f172a", dim: 0.2, clock: "time" } },
}
