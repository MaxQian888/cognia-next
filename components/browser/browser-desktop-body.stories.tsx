import type { Meta, StoryObj } from "@storybook/nextjs"

import { BrowserDesktopBody } from "./browser-desktop-body"

// Desktop layout for the in-app browser route: the FeaturePageShell wrapping the
// preview pane. On web the pane shows its sandboxed-iframe fallback.
const meta = {
  title: "Browser/BrowserDesktopBody",
  component: BrowserDesktopBody,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[560px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BrowserDesktopBody>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
