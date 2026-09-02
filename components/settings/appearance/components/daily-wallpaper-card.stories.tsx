import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { useState } from "react"

import { DailyWallpaperCard } from "./daily-wallpaper-card"
import {
  DEFAULT_DAILY_WALLPAPER,
  type DailyWallpaperSettings,
} from "@/types/appearance/daily-wallpaper"

function Harness(props: { initial?: Partial<DailyWallpaperSettings> }) {
  const [daily, setDaily] = useState<DailyWallpaperSettings>({
    ...DEFAULT_DAILY_WALLPAPER,
    enabled: true,
    ...props.initial,
  })
  return (
    <div className="max-w-xl p-4">
      <DailyWallpaperCard
        daily={daily}
        onChange={(patch) => setDaily((prev) => ({ ...prev, ...patch }))}
        onFetchNow={() => new Promise((resolve) => setTimeout(resolve, 1200))}
      />
    </div>
  )
}

const meta: Meta<typeof Harness> = {
  title: "Settings/Appearance/DailyWallpaperCard",
  component: Harness,
}
export default meta

type Story = StoryObj<typeof Harness>

export const Bing: Story = { args: {} }

export const Disabled: Story = { args: { initial: { enabled: false } } }

export const NasaApod: Story = { args: { initial: { providerId: "nasaApod" } } }

export const CustomJsonSource: Story = {
  args: {
    initial: {
      providerId: "custom",
      custom: {
        url: "https://example.com/daily.json",
        kind: "json",
        imagePath: "images.0.url",
      },
    },
  },
}

/** The last run succeeded. */
export const Fetched: Story = {
  args: { initial: { lastFetchedAt: Date.now() - 3_600_000 } },
}

/** The last run failed, and the panel says so rather than staying silent. */
export const RateLimited: Story = {
  args: {
    initial: {
      providerId: "nasaApod",
      lastError: { code: "rate-limited", at: Date.now() - 60_000, status: 429 },
    },
  },
}
