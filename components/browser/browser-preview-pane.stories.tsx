import type { Meta, StoryObj } from "@storybook/nextjs"

import { BrowserPreviewPane } from "./browser-preview-pane"

// The v0/Lovable-style preview pane. Outside Tauri (web/Capacitor) there is no
// native webview, so it falls back to the ai-elements WebPreview (sandboxed
// iframe + URL bar) — which is what Storybook renders.
const meta = {
  title: "Browser/BrowserPreviewPane",
  component: BrowserPreviewPane,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[520px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BrowserPreviewPane>

export default meta
type Story = StoryObj<typeof meta>

export const WebFallback: Story = {}
