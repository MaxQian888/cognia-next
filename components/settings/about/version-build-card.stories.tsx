import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { VersionBuildCard } from "./version-build-card"

// `nativeBuildLoader` is the component's test seam for the Capacitor native
// build number. We drive it here so the "build" row appears (or not) without
// any native bridge. Use the "Show advanced" toggle in the canvas to reveal the
// runtime-versions block (Tauri / React / web engine).
const meta = {
  title: "Settings/About/VersionBuildCard",
  component: VersionBuildCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof VersionBuildCard>

export default meta
type Story = StoryObj<typeof meta>

/** Web/desktop path: no native build number, so that row is omitted. */
export const Default: Story = {
  args: { nativeBuildLoader: async () => null },
}

/** Capacitor path: a native build number resolves and renders its own row. */
export const WithNativeBuild: Story = {
  args: { nativeBuildLoader: async () => "2048" },
}

/** Loader that never resolves — the card renders without the build row. */
export const NativeBuildPending: Story = {
  args: { nativeBuildLoader: () => new Promise<string | null>(() => {}) },
}
